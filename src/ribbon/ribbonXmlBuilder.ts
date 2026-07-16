import { XMLBuilder } from 'fast-xml-parser';
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
}

// Walks the model's tracked edits (added/modified/deleted) into the individual XML fragments a
// RibbonDiffXml is built from -- split out from buildRibbonDiffXml so mergeRibbonDiffXml below can
// splice these into an entity's actual existing diff instead of a bare skeleton.
export function buildRibbonDiffFragments(model: RibbonModel): RibbonDiffFragments {
    const customActions: string[] = [];
    const hideCustomActions: string[] = [];
    const removedCustomActionIds: string[] = [];
    let sequence = 100;

    for (const tab of model.tabs) {
        if (tab.status === 'added') {
            customActions.push(customAction(`${tab.id}.Custom`, 'Mscrm.Tabs._children', sequence++, serializeTab(tab)));
            continue; // groups/controls are already nested inside the serialized tab
        }
        if (tab.status === 'modified') {
            hideCustomActions.push(hideCustomAction(tab.id, 'Mscrm.Tabs._children'));
            customActions.push(customAction(`${tab.id}.Custom`, 'Mscrm.Tabs._children', sequence++, serializeTab(tab)));
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
                customActions.push(customAction(`${group.id}.Custom`, groupsLocation, sequence++, serializeGroup(group)));
                continue;
            }
            if (group.status === 'modified') {
                hideCustomActions.push(hideCustomAction(group.id, groupsLocation));
                customActions.push(customAction(`${group.id}.Custom`, groupsLocation, sequence++, serializeGroup(group)));
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
                    const seq = sequence++;
                    customActions.push(customAction(`${control.id}.Custom`, controlsLocation, seq, serializeControl(control, seq)));
                } else if (control.status === 'modified') {
                    hideCustomActions.push(hideCustomAction(control.id, controlsLocation));
                    const seq = sequence++;
                    customActions.push(customAction(`${control.id}.Custom`, controlsLocation, seq, serializeControl(control, seq)));
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

    return { customActions, hideCustomActions, commandDefinitions, enableRules, displayRules, removedCustomActionIds };
}

// Builds a standalone RibbonDiffXml containing only this session's tracked edits -- used by the
// "Export RibbonDiffXml" button, where showing just the delta is the point (human review of what
// changed). NOT used for publishToDynamics -- see mergeRibbonDiffXml below for why a full solution
// publish needs the entity's actual existing diff folded in instead of just this.
export function buildRibbonDiffXml(model: RibbonModel): string {
    const f = buildRibbonDiffFragments(model);
    return assembleRibbonDiffXml(f.customActions, f.hideCustomActions, f.commandDefinitions, f.enableRules, f.displayRules);
}

function assembleRibbonDiffXml(
    customActions: string[],
    hideCustomActions: string[],
    commandDefinitions: string[],
    enableRules: string[],
    displayRules: string[],
): string {
    return [
        '<RibbonDiffXml>',
        '  <CustomActions>',
        ...indentAll(customActions, 4),
        '  </CustomActions>',
        '  <Templates />',
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

    return assembleRibbonDiffXml(customActions, hideCustomActions, commandDefinitions, enableRules, displayRules);
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

function serializeTab(tab: RibbonTab): string {
    const obj: Record<string, unknown> = { '@_Id': tab.id };
    if (tab.title) { obj['@_Title'] = tab.title; }
    const groups = tab.groups.filter(g => g.status !== 'deleted');
    if (groups.length) { obj.Groups = { Group: groups.map(groupToObj) }; }
    return builder.build({ Tab: obj }) as string;
}

function serializeGroup(group: RibbonGroup): string {
    return builder.build({ Group: groupToObj(group) }) as string;
}

function groupToObj(group: RibbonGroup): Record<string, unknown> {
    const obj: Record<string, unknown> = { '@_Id': group.id };
    if (group.title) { obj['@_Title'] = group.title; }
    const controls = controlsToObj(group.controls);
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
function serializeControl(control: RibbonControl, sequence: number): string {
    const obj = controlToObj(control);
    obj['@_Sequence'] = String(sequence);
    obj['@_TemplateAlias'] = 'o2';
    return builder.build({ [control.kind]: obj }) as string;
}

function controlToObj(control: RibbonControl): Record<string, unknown> {
    const obj: Record<string, unknown> = { '@_Id': control.id };
    if (control.label) { obj['@_LabelText'] = control.label; }
    if (control.toolTipTitle) { obj['@_ToolTipTitle'] = control.toolTipTitle; }
    if (control.toolTipDescription) { obj['@_ToolTipDescription'] = control.toolTipDescription; }
    if (control.image16) { obj['@_Image16by16'] = control.image16; }
    if (control.image32) { obj['@_Image32by32'] = control.image32; }
    if (control.modernImage) { obj['@_ModernImage'] = control.modernImage; }
    if (control.commandId) { obj['@_Command'] = control.commandId; }

    const children = control.controls?.filter(c => c.status !== 'deleted') ?? [];
    if (control.kind === 'FlyoutAnchor' && children.length) {
        obj.Menu = { MenuSection: children.map(section => ({
            '@_Id': section.id,
            Controls: controlsToObj(section.controls ?? []),
        })) };
    } else if (control.kind === 'MenuSection' && children.length) {
        obj.Controls = controlsToObj(children);
    }
    return obj;
}

function controlsToObj(controls: RibbonControl[]): Record<string, unknown> | undefined {
    const grouped: Record<string, unknown[]> = {};
    for (const control of controls) {
        if (control.status === 'deleted') { continue; }
        (grouped[control.kind] ??= []).push(controlToObj(control));
    }
    return Object.keys(grouped).length ? grouped : undefined;
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
                    '@_Library': action.library,
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
