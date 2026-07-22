import { XMLBuilder } from 'fast-xml-parser';
import { MODERN_ICONS } from './modernIcons';
import type { RibbonCommandDefinition, RibbonControl, RibbonGroup, RibbonModel, RibbonTab } from './ribbonModel';

// Builds a `RibbonDiffXml` document from a RibbonModel that's been edited in the webview (each node
// tagged 'added' | 'modified' | 'deleted' | 'unchanged'). Mirrors how Ribbon Workbench itself
// represents changes: new nodes become <CustomAction>s anchored at their parent's `._children`
// location; edits to an existing node are a <HideCustomAction> for the original plus a
// <CustomAction> re-adding the edited version at the same location; deletions are just the Hide.
//
// Location strings use the common Ribbon Workbench anchor convention (`<parentId>.Groups._children`,
// `<parentId>.Controls._children`, `Mscrm.Tabs._children`) — a reasonable default anchor, refined
// once real import/publish support lands. This module has no `vscode` import and produces text only;
// nothing here talks to Dataverse.

// suppressBooleanAttributes defaults to true in fast-xml-parser, which would render any attribute
// whose value happens to be the string "true" as a bare, value-less attribute instead of
// `Attr="true"` -- none of the fields serialized below hit that today, but nothing here should rely
// on it staying that way.
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressEmptyNode: true, suppressBooleanAttributes: false });

// Resolves a tab/group/control's own Sequence -- see buildRibbonDiffFragments' seqOf for what "own
// Sequence" means and when it's the node's preserved original vs. a freshly assigned one.
type SeqOf = (node: { sequence?: string }) => number;

// Accumulates label output across the whole serialization pass -- `fragments` is the `<LocLabel>` XML
// (RibbonDiffFragments.locLabels), `resolved` is the same data as a plain LocLabel-Id -> literal-text
// map (RibbonDiffFragments.resolvedLabels) -- see labelRef, and that field's own doc comment for why
// a second, non-XML copy is worth keeping.
interface LabelAccumulator {
    fragments: string[];
    resolved: Record<string, string>;
}

export interface RibbonDiffFragments {
    customActions: string[];
    hideCustomActions: string[];
    commandDefinitions: string[];
    enableRules: string[];
    displayRules: string[];
    /** Ids of CustomActions (`{node.id}.Custom`) that should be dropped from an existing diff outright
     *  when merging, rather than left behind as inert dead weight -- one per tab/group/control marked
     *  'deleted' this session. A HideCustomAction is still emitted for the same node regardless (see
     *  the main loop below), since a 'deleted' node might be genuine base ribbon with no CustomAction
     *  to remove in the first place -- this list only matters when one actually exists. See
     *  mergeRibbonDiffXml. */
    removedCustomActionIds: string[];
    /** `<LocLabel>` fragments for any literal label/title/tooltip text emitted above -- see labelRef. */
    locLabels: string[];
    /** LocLabel Id -> the literal text it was generated from -- a plain-object mirror of `locLabels`
     *  (same entries, pre-XML), so a caller with nowhere else to get this back (RetrieveEntityRibbon's
     *  own LocLabels dictionary doesn't reliably resolve a custom entry, even right after publish --
     *  see ribbonEditorPanel.ts's resolvedLabelCache) can remember it locally instead. */
    resolvedLabels: Record<string, string>;
}

// Walks the model's tracked edits (added/modified/deleted) into the individual XML fragments a
// RibbonDiffXml is built from -- split out from buildRibbonDiffXml so mergeRibbonDiffXml below can
// splice these into an entity's actual existing diff instead of a bare skeleton.
export function buildRibbonDiffFragments(model: RibbonModel): RibbonDiffFragments {
    const customActions: string[] = [];
    const hideCustomActions: string[] = [];
    const removedCustomActionIds: string[] = [];
    const labels: LabelAccumulator = { fragments: [], resolved: {} };
    let sequence = 100;

    // A node's own original Sequence (parsed from the effective ribbon) is its position relative to
    // its siblings -- reusing it for a re-emitted 'modified' node keeps that position intact, since
    // its unmodified siblings keep whatever Sequence they already have too. Falling back to the
    // shared counter only for a node with no known original Sequence (freshly added this session, so
    // there's no existing position to preserve) -- see ribbonModel.ts's RibbonControl.sequence doc
    // comment, and reorderControl (ribbonState.ts) for the one case that deliberately assigns a new
    // Sequence to reflect a drag-and-drop move.
    const seqOf = (node: { sequence?: string }): number => node.sequence !== undefined ? Number(node.sequence) : sequence++;

    for (const tab of model.tabs) {
        if (tab.status === 'added') {
            const seq = seqOf(tab);
            customActions.push(customAction(`${tab.id}.Custom`, 'Mscrm.Tabs._children', seq, serializeTab(tab, seq, seqOf, labels)));
            continue; // groups/controls are already nested inside the serialized tab
        }
        if (tab.status === 'modified') {
            hideCustomActions.push(hideCustomAction(tab.id, 'Mscrm.Tabs._children'));
            const seq = seqOf(tab);
            customActions.push(customAction(`${tab.id}.Custom`, 'Mscrm.Tabs._children', seq, serializeTab(tab, seq, seqOf, labels)));
            continue;
        }
        if (tab.status === 'deleted') {
            hideCustomActions.push(hideCustomAction(tab.id, 'Mscrm.Tabs._children'));
            removedCustomActionIds.push(`${tab.id}.Custom`);
            continue;
        }

        const groupsLocation = `${tab.id}.Groups._children`;
        for (const group of tab.groups) {
            if (group.status === 'added') {
                const seq = seqOf(group);
                customActions.push(customAction(`${group.id}.Custom`, groupsLocation, seq, serializeGroup(group, seq, seqOf, labels)));
                continue;
            }
            if (group.status === 'modified') {
                hideCustomActions.push(hideCustomAction(group.id, groupsLocation));
                const seq = seqOf(group);
                customActions.push(customAction(`${group.id}.Custom`, groupsLocation, seq, serializeGroup(group, seq, seqOf, labels)));
                continue;
            }
            if (group.status === 'deleted') {
                hideCustomActions.push(hideCustomAction(group.id, groupsLocation));
                removedCustomActionIds.push(`${group.id}.Custom`);
                continue;
            }

            const controlsLocation = `${group.id}.Controls._children`;
            for (const control of group.controls) {
                if (control.status === 'added') {
                    const seq = seqOf(control);
                    customActions.push(customAction(`${control.id}.Custom`, controlsLocation, seq, serializeControl(control, seq, labels)));
                } else if (control.status === 'modified') {
                    hideCustomActions.push(hideCustomAction(control.id, controlsLocation));
                    const seq = seqOf(control);
                    customActions.push(customAction(`${control.id}.Custom`, controlsLocation, seq, serializeControl(control, seq, labels)));
                } else if (control.status === 'deleted') {
                    hideCustomActions.push(hideCustomAction(control.id, controlsLocation));
                    removedCustomActionIds.push(`${control.id}.Custom`);
                }
            }
        }
    }

    const commandDefinitions = model.commandDefinitions
        .filter(c => c.status === 'added' || c.status === 'modified')
        .map(serializeCommandDefinition);
    const enableRules = model.enableRules.filter(r => r.status === 'added' || r.status === 'modified').map(r => r.xml.trim());
    const displayRules = model.displayRules.filter(r => r.status === 'added' || r.status === 'modified').map(r => r.xml.trim());

    return {
        customActions, hideCustomActions, commandDefinitions, enableRules, displayRules, removedCustomActionIds,
        locLabels: labels.fragments, resolvedLabels: labels.resolved,
    };
}

// A FlyoutAnchor needs a <Menu> (or a PopulateQueryCommand, which this editor has no UI to set --
// see controlToObj) or Dataverse imports it fine but it can break publishing entirely down the line.
// Confirmed against a real org: reordering an unrelated sibling incidentally re-touched (and
// re-emitted) a base-ribbon FlyoutAnchor -- Mscrm.SubGrid.*.ChangeDataSetControlButton, a deprecated
// element Microsoft's own docs say isn't supported to modify, already missing both -- and republishing
// it broke every subsequent publish for the entity (Ribbon Workbench refused to publish anything else
// to that entity afterward; whatever compiles the effective ribbon for the running client also seems
// to choke on it). This editor's own serializer only ever omits Menu when a FlyoutAnchor has zero
// child controls (see controlToObj), so a self-closing <FlyoutAnchor ... /> in what's about to be
// published is exactly this failure mode -- checked here, against the actual about-to-be-sent
// fragments, so it catches a FlyoutAnchor pulled in through ANY path (directly edited, reordered
// alongside, or nested in a wholesale group/tab re-serialize), not just one this editor itself just
// added. Returns the offending Ids, or an empty array if publishing is safe.
export function findInvalidFlyoutAnchors(fragments: Pick<RibbonDiffFragments, 'customActions'>): string[] {
    const ids: string[] = [];
    const flyoutTagRe = /<FlyoutAnchor\b([^>]*?)(\/>|>)/g;
    for (const fragment of fragments.customActions) {
        flyoutTagRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = flyoutTagRe.exec(fragment))) {
            const [, attrs, closing] = m;
            if (closing !== '/>') { continue; } // has a Menu (see controlToObj) -- fine
            if (/\bPopulateQueryCommand\s*=/.test(attrs)) { continue; }
            ids.push(/\bId="([^"]*)"/.exec(attrs)?.[1] ?? '(unknown Id)');
        }
    }
    return ids;
}

// Builds a standalone RibbonDiffXml containing only this session's tracked edits -- used by the
// "Export RibbonDiffXml" button, where showing just the delta is the point (human review of what
// changed). NOT used for publishToDynamics -- see mergeRibbonDiffXml below for why a full solution
// publish needs the entity's actual existing diff folded in instead of just this.
export function buildRibbonDiffXml(model: RibbonModel): string {
    const f = buildRibbonDiffFragments(model);
    return assembleRibbonDiffXml(f.customActions, f.hideCustomActions, f.commandDefinitions, f.enableRules, f.displayRules, f.locLabels);
}

function assembleRibbonDiffXml(
    customActions: string[],
    hideCustomActions: string[],
    commandDefinitions: string[],
    enableRules: string[],
    displayRules: string[],
    locLabels: string[],
    // This editor has no UI for custom Group/Ribbon templates and never edits this section -- unlike
    // every other section below, there is no "this session's changes" to merge in, only the entity's
    // existing content (if any) to leave alone. Defaults to empty for buildRibbonDiffXml's standalone
    // delta export (which has no "existing" to preserve in the first place); mergeRibbonDiffXml always
    // passes the real existing block through instead. Getting this wrong previously meant every
    // publish silently replaced the entity's actual Templates section with an empty one -- a real,
    // confirmed instance of exactly the kind of silent corruption this tool must never cause.
    templatesXml = '<Templates />',
): string {
    return [
        '<RibbonDiffXml>',
        '  <CustomActions>',
        ...indentAll(customActions, 4),
        '  </CustomActions>',
        ...indent(templatesXml.trim(), 2).split('\n'),
        '  <CommandDefinitions>',
        ...indentAll(commandDefinitions, 4),
        '  </CommandDefinitions>',
        '  <RuleDefinitions>',
        '    <TabDisplayRules />',
        '    <DisplayRules>',
        ...indentAll(displayRules, 6),
        '    </DisplayRules>',
        '    <EnableRules>',
        ...indentAll(enableRules, 6),
        '    </EnableRules>',
        '  </RuleDefinitions>',
        '  <LocLabels>',
        ...indentAll(locLabels, 4),
        '  </LocLabels>',
        '  <HideCustomActions>',
        ...indentAll(hideCustomActions, 4),
        '  </HideCustomActions>',
        '</RibbonDiffXml>',
    ].join('\n');
}

// Merges this session's edits into the entity's ACTUAL existing RibbonDiffXml (fetched separately --
// see dataverseClient.ts's getEntityCurrentRibbonDiffXml) instead of rebuilding a diff purely from
// this model's tracked statuses. Every node this editor loads starts life as 'unchanged' with no way
// to tell "an existing customization" apart from "Microsoft's base ribbon" (both come back merged
// together from RetrieveEntityRibbon) -- and ImportSolution's RibbonDiffXml REPLACES an entity's
// entire unmanaged ribbon diff wholesale, confirmed against a live environment. Publishing only this
// session's delta therefore silently dropped every customization -- this tool's own or anyone else's
// (Ribbon Workbench, hand-edited) -- that wasn't touched in the current session. Fetching the raw
// existing diff and merging fragment-by-Id -- keeping everything untouched byte-for-byte, only
// replacing/adding what this session's edits produce -- fixes that without this editor ever needing
// to know which merged-ribbon nodes were customizations to begin with.
export function mergeRibbonDiffXml(existingRibbonDiffXml: string, model: RibbonModel): string {
    const f = buildRibbonDiffFragments(model);

    // Deleted nodes get their own CustomAction (if one exists) stripped outright, on top of the
    // ordinary Id-collision exclusion below -- see removedCustomActionIds' own doc comment.
    const customActions = mergeSection(existingRibbonDiffXml, 'CustomActions', f.customActions, new Set(f.removedCustomActionIds));
    const hideCustomActions = mergeSection(existingRibbonDiffXml, 'HideCustomActions', f.hideCustomActions);
    const commandDefinitions = mergeSection(existingRibbonDiffXml, 'CommandDefinitions', f.commandDefinitions);

    const ruleDefinitions = extractElementInner(existingRibbonDiffXml, 'RuleDefinitions') ?? '';
    const enableRules = mergeSection(ruleDefinitions, 'EnableRules', f.enableRules);
    const displayRules = mergeSection(ruleDefinitions, 'DisplayRules', f.displayRules);
    const locLabels = mergeSection(existingRibbonDiffXml, 'LocLabels', f.locLabels);
    const templatesXml = extractOuterElement(existingRibbonDiffXml, 'Templates') ?? '<Templates />';

    return assembleRibbonDiffXml(customActions, hideCustomActions, commandDefinitions, enableRules, displayRules, locLabels, templatesXml);
}

// Fills in any still-unresolved `$LocLabels:` reference in `model` from a locally-remembered cache of
// labels this tool itself most recently published for that Id -- see ribbonEditorPanel.ts's
// resolvedLabelCache. RetrieveEntityRibbon's own LocLabels dictionary doesn't reliably resolve a
// custom entry back to its literal text -- confirmed even right after a full "regenerate ribbon
// metadata" -- even though the label displays correctly in the actual running app; this is purely a
// workaround for that read-side gap, not a correction to anything wrong in the published ribbon. A
// cache miss (base ribbon, another tool's customization, or a fresh workspace) leaves the raw
// reference exactly as parsed, falling through to the usual guess-from-Id display. Mutates `model` in
// place -- safe here since it's only ever called on a model freshly returned from parseRibbonXml,
// before anything else observes it.
export function resolveLabelsFromCache(model: RibbonModel, cache: Record<string, string>): void {
    for (const tab of model.tabs) {
        tab.title = resolveFromCache(tab.title, `${tab.id}.Title`, cache);
        for (const group of tab.groups) {
            group.title = resolveFromCache(group.title, `${group.id}.Title`, cache);
            resolveControlLabelsFromCache(group.controls, cache);
        }
    }
}

function resolveControlLabelsFromCache(controls: RibbonControl[], cache: Record<string, string>): void {
    for (const control of controls) {
        control.label = resolveFromCache(control.label, `${control.id}.LabelText`, cache);
        control.toolTipTitle = resolveFromCache(control.toolTipTitle, `${control.id}.ToolTipTitle`, cache);
        control.toolTipDescription = resolveFromCache(control.toolTipDescription, `${control.id}.ToolTipDescription`, cache);
        if (control.controls) { resolveControlLabelsFromCache(control.controls, cache); }
    }
}

function resolveFromCache(raw: string, locLabelId: string, cache: Record<string, string>): string {
    return raw === `$LocLabels:${locLabelId}` ? (cache[locLabelId] ?? raw) : raw;
}

// Keeps every existing top-level fragment in `sectionTag` whose Id doesn't collide with one of
// `newFragments`, and isn't in `extraExcludeIds`, verbatim byte-for-byte from the source diff, then
// appends the new ones -- so an edit to a previously-customized node replaces its old fragment
// instead of duplicating it (which would otherwise leave two same-Id CustomActions for the same
// node), a delete removes it outright (extraExcludeIds), and anything untouched this session passes
// through unchanged.
function mergeSection(containerXml: string, sectionTag: string, newFragments: string[], extraExcludeIds?: Set<string>): string[] {
    const existingInner = extractElementInner(containerXml, sectionTag) ?? '';
    const newIds = new Set(newFragments.map(extractId).filter((id): id is string => !!id));
    const kept = splitTopLevelElements(existingInner)
        .filter(f => !f.id || (!newIds.has(f.id) && !extraExcludeIds?.has(f.id)))
        .map(f => f.xml);
    return [...kept, ...newFragments];
}

// Returns the inner text of the first `<tag>...</tag>` (or '' for a self-closing `<tag />`) found
// anywhere in `xml`, or undefined if `tag` doesn't appear at all. Unanchored on purpose -- callers
// only ever look for RibbonDiffXml's small set of fixed, non-repeating top-level section names.
function extractElementInner(xml: string, tag: string): string | undefined {
    const openMatch = new RegExp(`<${tag}(?:\\s[^>]*)?/>|<${tag}(?:\\s[^>]*)?>`).exec(xml);
    if (!openMatch) { return undefined; }
    if (openMatch[0].endsWith('/>')) { return ''; }
    const closeTag = `</${tag}>`;
    const closeIdx = xml.indexOf(closeTag, openMatch.index + openMatch[0].length);
    if (closeIdx === -1) { return undefined; }
    return xml.slice(openMatch.index + openMatch[0].length, closeIdx);
}

// Same search as extractElementInner, but returns the WHOLE matched element (open tag through close
// tag, or the self-closing tag itself) verbatim rather than just its inner text -- used for a section
// this editor only ever needs to pass through untouched (see assembleRibbonDiffXml's templatesXml),
// never to parse/rebuild.
function extractOuterElement(xml: string, tag: string): string | undefined {
    const openMatch = new RegExp(`<${tag}(?:\\s[^>]*)?/>|<${tag}(?:\\s[^>]*)?>`).exec(xml);
    if (!openMatch) { return undefined; }
    if (openMatch[0].endsWith('/>')) { return openMatch[0]; }
    const closeTag = `</${tag}>`;
    const closeIdx = xml.indexOf(closeTag, openMatch.index + openMatch[0].length);
    if (closeIdx === -1) { return undefined; }
    return xml.slice(openMatch.index, closeIdx + closeTag.length);
}

function extractId(xmlFragment: string): string | undefined {
    return /\bId\s*=\s*"([^"]*)"/.exec(xmlFragment)?.[1];
}

// Splits a section's inner XML into its immediate child elements (each one possibly containing its
// own deeply-nested markup, e.g. a CustomAction's CommandUIDefinition/Button/etc.), pairing each with
// its own Id attribute -- generic depth tracking over every tag encountered, not just same-name
// pairs, since children nest tags of many different names.
const TAG_TOKEN_RE = /<([a-zA-Z_][\w.-]*)((?:\s+[^<>]*?)?)(\/?)>|<\/([a-zA-Z_][\w.-]*)\s*>/g;

function splitTopLevelElements(innerXml: string): Array<{ id: string | undefined; xml: string }> {
    const results: Array<{ id: string | undefined; xml: string }> = [];
    let depth = 0;
    let start = -1;
    let currentId: string | undefined;
    TAG_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_TOKEN_RE.exec(innerXml))) {
        const isClosing = m[4] !== undefined;
        const isSelfClosing = m[3] === '/';

        if (depth === 0 && !isClosing) {
            start = m.index;
            currentId = extractId(m[0]);
        }
        if (!isClosing && !isSelfClosing) {
            depth++;
        } else if (isClosing) {
            depth--;
        }

        if (depth === 0 && start >= 0) {
            results.push({ id: currentId, xml: innerXml.slice(start, m.index + m[0].length).trim() });
            start = -1;
        }
    }
    return results;
}

// ── Node serialization (RibbonModel -> XML fragment) ─────────────────────────

function serializeTab(tab: RibbonTab, seq: number, seqOf: SeqOf, labels: LabelAccumulator): string {
    const obj: Record<string, unknown> = { '@_Id': tab.id, '@_Sequence': String(seq) };
    const title = labelRef(tab.title, `${tab.id}.Title`, labels);
    if (title) { obj['@_Title'] = title; }
    const groups = tab.groups.filter(g => g.status !== 'deleted');
    if (groups.length) { obj.Groups = { Group: groups.map(g => groupToObj(g, seqOf(g), seqOf, labels)) }; }
    return builder.build({ Tab: obj }) as string;
}

function serializeGroup(group: RibbonGroup, seq: number, seqOf: SeqOf, labels: LabelAccumulator): string {
    return builder.build({ Group: groupToObj(group, seq, seqOf, labels) }) as string;
}

// Template/Command are mandatory in practice on every real Group -- Template is what actually gives
// the group's Controls a layout to render into (a Group with no Template either fails validation or
// silently never shows any of its controls, confirmed against a live environment: a custom group
// published without one keeps every button added to it invisible no matter what else about the
// button is correct). Preserves an existing group's own real values (parsed verbatim -- see
// ribbonXmlParser.ts); only a group added this session, which never had either, falls back to
// "Mscrm.Templates.Flexible2"/"Mscrm.Enabled" -- both confirmed against real production ribbon
// exports (e.g. this exact pairing on the stock 'Management' group present in every entity's
// grid/subgrid ribbon), not a guess.
function groupToObj(group: RibbonGroup, seq: number, seqOf: SeqOf, labels: LabelAccumulator): Record<string, unknown> {
    const obj: Record<string, unknown> = {
        '@_Id': group.id,
        '@_Sequence': String(seq),
        '@_Template': group.template ?? 'Mscrm.Templates.Flexible2',
        '@_Command': group.command ?? 'Mscrm.Enabled',
    };
    const title = labelRef(group.title, `${group.id}.Title`, labels);
    if (title) { obj['@_Title'] = title; }
    const controls = controlsToObj(group.controls, labels, seqOf);
    if (controls) { obj.Controls = controls; }
    return obj;
}

// Sequence and TemplateAlias here are attributes on the *Button/SplitButton/FlyoutAnchor element
// itself*, distinct from the CustomAction wrapper's own Sequence -- confirmed against a real
// production RibbonDiffXml export, where every custom control placed directly in a group carries
// both, matching its enclosing CustomAction's Sequence. TemplateAlias in particular isn't optional
// in practice: a control added without it can import successfully yet never actually render on the
// command bar, since it has no named slot in its group's template to render into -- a well-known
// gotcha in manual/Ribbon-Workbench-style ribbon customization. "o2" is the standard alias used for
// a normal icon+label control in the common default/Flexible group templates (both Microsoft's own
// built-in groups like Save, and the default template Dataverse assigns to a newly created group).
// Scoped to only this direct "control added/modified in an existing group" path -- not the shared
// controlToObj used for nested Menu/FlyoutAnchor children -- since there's no evidence yet either
// way for how those should behave, and guessing wrong there risks the opposite problem instead.
function serializeControl(control: RibbonControl, sequence: number, labels: LabelAccumulator): string {
    const obj = controlToObj(control, labels);
    obj['@_Sequence'] = String(sequence);
    obj['@_TemplateAlias'] = 'o2';
    return builder.build({ [control.kind]: obj }) as string;
}

function controlToObj(control: RibbonControl, labels: LabelAccumulator, seq?: number): Record<string, unknown> {
    const obj: Record<string, unknown> = { '@_Id': control.id };
    if (seq !== undefined) { obj['@_Sequence'] = String(seq); }
    const label = labelRef(control.label, `${control.id}.LabelText`, labels);
    if (label) { obj['@_LabelText'] = label; }
    const toolTipTitle = labelRef(control.toolTipTitle, `${control.id}.ToolTipTitle`, labels);
    if (toolTipTitle) { obj['@_ToolTipTitle'] = toolTipTitle; }
    const toolTipDescription = labelRef(control.toolTipDescription, `${control.id}.ToolTipDescription`, labels);
    if (toolTipDescription) { obj['@_ToolTipDescription'] = toolTipDescription; }
    if (control.image16) { obj['@_Image16by16'] = webResourceRef(control.image16); }
    if (control.image32) { obj['@_Image32by32'] = webResourceRef(control.image32); }
    if (control.modernImage) { obj['@_ModernImage'] = modernImageRef(control.modernImage); }
    if (control.commandId) { obj['@_Command'] = control.commandId; }

    // Nested Menu/MenuSection children deliberately never get a Sequence assigned here (no seqOf
    // passed down) -- see serializeControl's own doc comment above: there's no evidence yet for how
    // Sequence should behave on flyout-nested controls, and guessing wrong risks the opposite problem.
    const children = control.controls?.filter(c => c.status !== 'deleted') ?? [];
    if (control.kind === 'FlyoutAnchor' && children.length) {
        obj.Menu = { MenuSection: children.map(section => ({
            '@_Id': section.id,
            Controls: controlsToObj(section.controls ?? [], labels),
        })) };
    } else if (control.kind === 'MenuSection' && children.length) {
        obj.Controls = controlsToObj(children, labels);
    }
    return obj;
}

// `seqOf`, when passed, resolves each direct child's own Sequence (preserving its original position,
// or assigning a fresh one -- see buildRibbonDiffFragments' own seqOf) -- used for a group's direct
// controls when the enclosing group/tab itself is being wholesale re-serialized (so an edit to just
// the group's title, say, doesn't also silently drop every one of its buttons' Sequence and leave
// their order undefined). Omitted (menu-nested children, see controlToObj) to leave those unchanged.
function controlsToObj(controls: RibbonControl[], labels: LabelAccumulator, seqOf?: SeqOf): Record<string, unknown> | undefined {
    const grouped: Record<string, unknown[]> = {};
    for (const control of controls) {
        if (control.status === 'deleted') { continue; }
        (grouped[control.kind] ??= []).push(controlToObj(control, labels, seqOf?.(control)));
    }
    return Object.keys(grouped).length ? grouped : undefined;
}

// Dataverse's own ribbon renderer only resolves Image16by16/Image32by32/ModernImage/JavaScriptFunction
// Library attributes that carry the explicit `$webresource:` prefix -- a bare web resource name
// previews fine in this editor (getRibbonImageContent falls back to a direct name lookup, see
// dataverseClient.ts) but silently fails to render once actually published. Idempotent (a value
// already prefixed, or a `/`-rooted system path, passes through untouched) and never applied to an
// empty value, so "no icon set" still serializes to no attribute at all.
function webResourceRef(value: string): string {
    if (!value || value.startsWith('$webresource:') || value.startsWith('/')) { return value; }
    return `$webresource:${value}`;
}

// Same idea as webResourceRef, but ModernImage can also legitimately be one of Dataverse's built-in
// Fluent icon names (e.g. "Refresh") rather than a web resource -- see fluentIcon.ts. Prefixing one of
// those would turn it into a web resource lookup that can never resolve, so known built-in names are
// left bare.
function modernImageRef(value: string): string {
    if (!value || value.startsWith('$webresource:') || value.startsWith('/')) { return value; }
    if (Object.prototype.hasOwnProperty.call(MODERN_ICONS, value.trim())) { return value; }
    return `$webresource:${value}`;
}

// Converts literal label/title/tooltip text into a `$LocLabels:` reference plus a matching <LocLabel>
// fragment -- Dataverse's ribbon schema expects labels to be resolved through LocLabels rather than
// carried as raw LabelText/Title/ToolTip* strings (see
// https://learn.microsoft.com/power-apps/developer/model-driven-apps/use-localized-labels-ribbons).
// A value that's already an unresolved `$LocLabels:`/`$Resources:` reference (untouched base-ribbon
// content, or a prior customization) passes through as-is rather than being wrapped again. Returns
// undefined for an empty value, so the caller can omit the attribute entirely -- matching every other
// optional attribute in this file.
function labelRef(value: string, locLabelId: string, labels: LabelAccumulator): string | undefined {
    if (!value) { return undefined; }
    if (value.startsWith('$LocLabels:') || value.startsWith('$Resources:')) { return value; }
    labels.fragments.push(
        `<LocLabel Id="${escapeAttr(locLabelId)}">\n  <Titles>\n    <Title languagecode="1033" description="${escapeAttr(value)}" />\n  </Titles>\n</LocLabel>`,
    );
    labels.resolved[locLabelId] = value;
    return `$LocLabels:${locLabelId}`;
}

function serializeCommandDefinition(cmd: RibbonCommandDefinition): string {
    const obj: Record<string, unknown> = { '@_Id': cmd.id };
    // Always present (as an empty self-closing element when there are no rules), matching a real
    // Dataverse-exported CommandDefinition -- unlike Templates/DisplayRules/EnableRules at the
    // RibbonDiffXml root, which genuinely are optional wrapper sections.
    obj.EnableRules = cmd.enableRules.length ? { EnableRule: cmd.enableRules.map(id => ({ '@_Id': id })) } : {};
    obj.DisplayRules = cmd.displayRules.length ? { DisplayRule: cmd.displayRules.map(id => ({ '@_Id': id })) } : {};
    if (cmd.actions.length) {
        const actions: Record<string, unknown[]> = {};
        for (const action of cmd.actions) {
            if (action.type === 'JavaScriptFunction') {
                const paramsByTag: Record<string, unknown[]> = {};
                for (const p of action.params) {
                    const value = p.type === 'BoolParameter' ? (p.value ? 'true' : 'false') : p.value;
                    (paramsByTag[p.type] ??= []).push({ '@_Value': value });
                }
                (actions.JavaScriptFunction ??= []).push({
                    '@_Library': webResourceRef(action.library),
                    '@_FunctionName': action.functionName,
                    ...paramsByTag,
                });
            } else if (action.type === 'Url') {
                (actions.Url ??= []).push({ '@_Address': action.address });
            }
            // 'Raw' actions preserved verbatim aren't representable via the object builder; they're
            // dropped here since CommandDefinition edits always originate from structured actions in
            // this editor's UI (raw actions pass through unmodified via 'unchanged' commands, which
            // aren't emitted into the diff at all).
        }
        obj.Actions = actions;
    }
    return builder.build({ CommandDefinition: obj }) as string;
}

// ── CustomAction / HideCustomAction wrappers ─────────────────────────────────

// A CustomAction's actual ribbon markup (Tab/Group/Button/etc.) must be wrapped in a
// CommandUIDefinition element -- omitting it isn't just non-standard, Dataverse's import rejects it
// outright ("Either the CommandUIDefinition element is missing, or the CommandUIDefinition element
// is empty for CustomAction element with Id=..."), caught by an actual import against a live
// environment.
function customAction(id: string, location: string, sequence: number, innerXml: string): string {
    return `<CustomAction Id="${escapeAttr(id)}" Location="${escapeAttr(location)}" Sequence="${sequence}">\n  <CommandUIDefinition>\n${indent(innerXml.trim(), 4)}\n  </CommandUIDefinition>\n</CustomAction>`;
}

function hideCustomAction(targetId: string, location: string): string {
    return `<HideCustomAction Id="${escapeAttr(`${targetId}.Hide`)}" Location="${escapeAttr(location)}" CommandUIElementId="${escapeAttr(targetId)}" />`;
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return text.split('\n').map(line => pad + line).join('\n');
}

function indentAll(fragments: string[], spaces: number): string[] {
    return fragments.flatMap(f => indent(f, spaces).split('\n'));
}
