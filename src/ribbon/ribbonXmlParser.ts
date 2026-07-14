import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type {
    RibbonAction,
    RibbonCommandDefinition,
    RibbonControl,
    RibbonModel,
    RibbonRuleRaw,
} from './ribbonModel';

// Parses the XML returned by DataverseClient.getEntityRibbonXml — the effective (merged) ribbon,
// shaped `<RibbonDefinitions><RibbonXml>…</RibbonXml><LocLabels>…</LocLabels></RibbonDefinitions>` —
// into a plain RibbonModel. Pure / no `vscode` import, so it's usable from tests and (indirectly,
// via the extension host) the webview.

// Tags that can repeat and must always deserialize as arrays, even when there's exactly one.
const ARRAY_TAGS = new Set([
    'Tab', 'Group', 'Button', 'SplitButton', 'FlyoutAnchor', 'MenuSection',
    'CommandDefinition', 'EnableRule', 'DisplayRule', 'LocLabel', 'Title',
    'CrmParameter', 'StringParameter', 'JavaScriptFunction', 'Url', 'ContextualGroup',
]);

const CONTROL_TAGS = new Set(['Button', 'SplitButton', 'FlyoutAnchor', 'MenuSection']);

function makeParser(): XMLParser {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseAttributeValue: false,
        isArray: name => ARRAY_TAGS.has(name),
    });
}

export function parseRibbonXml(xml: string): RibbonModel {
    const parser = makeParser();
    const doc = parser.parse(xml) as Record<string, unknown>;

    const definitions = asObj(doc.RibbonDefinitions) ?? doc;
    const locLabels = parseLocLabels(asObj(definitions.LocLabels));

    // The real shape RetrieveEntityRibbon returns — confirmed against a live capture — is:
    //   RibbonDefinitions > RibbonDefinition > UI > Ribbon > Tabs
    //   RibbonDefinitions > RibbonDefinition > CommandDefinitions   (sibling of UI, not nested in it)
    //   RibbonDefinitions > RibbonDefinition > RuleDefinitions      (sibling of UI, not nested in it)
    // Older sample code (and some docs) show a flatter RibbonDefinitions > RibbonXml > {Tabs,
    // CommandDefinitions, RuleDefinitions} shape instead, so that's kept as a fallback for Tabs and
    // as a secondary lookup for the other two.
    const ribbonDefinition = asObj(definitions.RibbonDefinition);
    const flatFallback = asObj(definitions.RibbonXml);
    const ribbon = asObj(asObj(ribbonDefinition?.UI)?.Ribbon) ?? flatFallback ?? definitions;

    // Sub-Grid (and some Form) tabs don't live directly under <Tabs> — they're contextual tabs,
    // nested <Tabs><ContextualTabs><ContextualGroup><Tab>…</Tab></ContextualGroup></ContextualTabs>
    // (confirmed against a live 'contact' Sub-Grid capture, where <Tabs> is an empty self-closing
    // element and the actual Mscrm.SubGrid.contact.MainTab lives inside a ContextualGroup instead).
    const tabs = [
        ...parseTabs(asObj(ribbon.Tabs), locLabels),
        ...parseContextualTabs(asObj(ribbon.ContextualTabs), locLabels),
    ];
    const commandDefinitions = parseCommandDefinitions(
        asObj(ribbonDefinition?.CommandDefinitions) ?? asObj(flatFallback?.CommandDefinitions),
    );

    const ruleDefinitions = asObj(ribbonDefinition?.RuleDefinitions) ?? asObj(flatFallback?.RuleDefinitions);
    const enableRules = parseRules(asObj(ruleDefinitions?.EnableRules), 'EnableRule');
    const displayRules = parseRules(asObj(ruleDefinitions?.DisplayRules), 'DisplayRule');

    return { tabs, commandDefinitions, enableRules, displayRules, locLabels };
}

// ── LocLabels ────────────────────────────────────────────────────────────────

function parseLocLabels(locLabelsNode: Record<string, unknown> | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    const labels = asArray(locLabelsNode?.LocLabel);
    for (const label of labels) {
        const obj = asObj(label);
        if (!obj) { continue; }
        const id = attr(obj, 'Id');
        if (!id) { continue; }

        const titles = asArray(asObj(obj.Titles)?.Title).map(asObj).filter(isObj);
        const title = titles.find(t => attr(t, 'languagecode') === '1033') ?? titles[0];
        result[id] = (title && attr(title, 'description')) || '';
    }
    return result;
}

function resolveLabel(raw: string | undefined, locLabels: Record<string, string>): string {
    if (!raw) { return ''; }
    if (raw.startsWith('$LocLabels:')) {
        // RetrieveEntityRibbon's effective ribbon doesn't ship a <LocLabels> dictionary in
        // practice (confirmed against a live capture — every label is a reference, none resolve
        // locally), so falling back to '' would render every single control blank. Show the raw
        // reference instead — still identifiable, and literal text typed in this editor overrides
        // it entirely when a control is edited.
        const id = raw.slice('$LocLabels:'.length);
        return locLabels[id] ?? raw;
    }
    // $Resources:... references (RESX-based) aren't resolved either — shown as-is for the same reason.
    return raw;
}

// ── Tabs / Groups / Controls ─────────────────────────────────────────────────

function parseTabs(tabsNode: Record<string, unknown> | undefined, locLabels: Record<string, string>) {
    return parseTabList(asArray(tabsNode?.Tab), locLabels);
}

function parseContextualTabs(contextualTabsNode: Record<string, unknown> | undefined, locLabels: Record<string, string>) {
    const groups = asArray(contextualTabsNode?.ContextualGroup).map(asObj).filter(isObj);
    return groups.flatMap(group => parseTabList(asArray(group.Tab), locLabels));
}

function parseTabList(rawTabs: unknown[], locLabels: Record<string, string>) {
    return rawTabs.map(asObj).filter(isObj).map(tab => ({
        id: attr(tab, 'Id') ?? '',
        title: resolveTitle(tab, locLabels),
        groups: parseGroups(asObj(tab.Groups), locLabels),
        status: 'unchanged' as const,
    }));
}

function parseGroups(groupsNode: Record<string, unknown> | undefined, locLabels: Record<string, string>) {
    return asArray(groupsNode?.Group).map(asObj).filter(isObj).map(group => ({
        id: attr(group, 'Id') ?? '',
        title: resolveTitle(group, locLabels),
        controls: parseControls(asObj(group.Controls), locLabels),
        status: 'unchanged' as const,
    }));
}

function resolveTitle(node: Record<string, unknown>, locLabels: Record<string, string>): string {
    const titleAttr = attr(node, 'Title');
    if (titleAttr) { return resolveLabel(titleAttr, locLabels); }

    // Some templates carry an inline <Titles><Title description="…" languagecode="1033"/></Titles>.
    const titles = asArray(asObj(node.Titles)?.Title).map(asObj).filter(isObj);
    const title = titles.find(t => attr(t, 'languagecode') === '1033') ?? titles[0];
    return (title && attr(title, 'description')) || '';
}

function parseControls(controlsNode: Record<string, unknown> | undefined, locLabels: Record<string, string>): RibbonControl[] {
    if (!controlsNode) { return []; }

    const result: RibbonControl[] = [];
    for (const tag of Object.keys(controlsNode)) {
        if (!CONTROL_TAGS.has(tag)) { continue; }
        for (const raw of asArray(controlsNode[tag])) {
            const node = asObj(raw);
            if (!node) { continue; }
            result.push(parseControl(tag as RibbonControl['kind'], node, locLabels));
        }
    }
    return result;
}

function parseControl(kind: RibbonControl['kind'], node: Record<string, unknown>, locLabels: Record<string, string>): RibbonControl {
    // FlyoutAnchor nests its children under Menu > MenuSection > Controls; MenuSection nests
    // Controls directly — see the `controls:` field below.
    return {
        kind,
        id: attr(node, 'Id') ?? '',
        label: resolveLabel(attr(node, 'LabelText'), locLabels),
        toolTipTitle: resolveLabel(attr(node, 'ToolTipTitle'), locLabels),
        toolTipDescription: resolveLabel(attr(node, 'ToolTipDescription'), locLabels),
        image16: attr(node, 'Image16by16'),
        image32: attr(node, 'Image32by32'),
        modernImage: attr(node, 'ModernImage'),
        commandId: attr(node, 'Command'),
        controls: kind === 'FlyoutAnchor'
            ? parseMenuSections(asObj(node.Menu), locLabels)
            : kind === 'MenuSection' ? parseControls(asObj(node.Controls), locLabels) : undefined,
        status: 'unchanged',
    };
}

function parseMenuSections(menuNode: Record<string, unknown> | undefined, locLabels: Record<string, string>): RibbonControl[] {
    return asArray(menuNode?.MenuSection).map(asObj).filter(isObj).map(section => ({
        kind: 'MenuSection' as const,
        id: attr(section, 'Id') ?? '',
        label: '',
        toolTipTitle: '',
        toolTipDescription: '',
        controls: parseControls(asObj(section.Controls), locLabels),
        status: 'unchanged' as const,
    }));
}

// ── Command definitions ───────────────────────────────────────────────────────

function parseCommandDefinitions(node: Record<string, unknown> | undefined): RibbonCommandDefinition[] {
    return asArray(node?.CommandDefinition).map(asObj).filter(isObj).map(cmd => ({
        id: attr(cmd, 'Id') ?? '',
        enableRules: asArray(asObj(cmd.EnableRules)?.EnableRule).map(asObj).filter(isObj).map(r => attr(r, 'Id') ?? '').filter(Boolean),
        displayRules: asArray(asObj(cmd.DisplayRules)?.DisplayRule).map(asObj).filter(isObj).map(r => attr(r, 'Id') ?? '').filter(Boolean),
        actions: parseActions(asObj(cmd.Actions)),
        status: 'unchanged' as const,
    }));
}

function parseActions(actionsNode: Record<string, unknown> | undefined): RibbonAction[] {
    if (!actionsNode) { return []; }
    const result: RibbonAction[] = [];

    for (const raw of asArray(actionsNode.JavaScriptFunction)) {
        const node = asObj(raw);
        if (!node) { continue; }

        // Parameters are positional JS function arguments, so their order matters. fast-xml-parser
        // (without the heavier preserveOrder mode) groups same-tag siblings into arrays but keeps
        // distinct tag names in first-encountered order — walking Object.keys() recovers the
        // original document order for contiguous runs of CrmParameter/StringParameter, which covers
        // the common case (params of one type aren't usually interleaved with the other).
        const params: string[] = [];
        for (const key of Object.keys(node)) {
            if (key !== 'CrmParameter' && key !== 'StringParameter') { continue; }
            for (const p of asArray(node[key]).map(asObj).filter(isObj)) {
                params.push(attr(p, 'Value') ?? '');
            }
        }
        result.push({ type: 'JavaScriptFunction', library: attr(node, 'Library') ?? '', functionName: attr(node, 'FunctionName') ?? '', params });
    }

    for (const raw of asArray(actionsNode.Url)) {
        const node = asObj(raw);
        if (!node) { continue; }
        result.push({ type: 'Url', address: attr(node, 'Address') ?? '' });
    }

    // Any action type we don't model explicitly is preserved as raw XML so it round-trips.
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
    for (const [tag, value] of Object.entries(actionsNode)) {
        if (tag === 'JavaScriptFunction' || tag === 'Url') { continue; }
        for (const raw of asArray(value)) {
            result.push({ type: 'Raw', xml: builder.build({ [tag]: raw }) as string });
        }
    }

    return result;
}

// ── Rule definitions (kept opaque) ───────────────────────────────────────────

function parseRules(node: Record<string, unknown> | undefined, tag: 'EnableRule' | 'DisplayRule'): RibbonRuleRaw[] {
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
    return asArray(node?.[tag]).map(asObj).filter(isObj).map(rule => ({
        id: attr(rule, 'Id') ?? '',
        xml: builder.build({ [tag]: rule }) as string,
        status: 'unchanged' as const,
    }));
}

// ── Small XML-object helpers ──────────────────────────────────────────────────
// fast-xml-parser represents a single child as an object and a repeated one as an array (unless
// forced via isArray); these normalize both shapes for the callers above.

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
    return isObj(v) ? v : undefined;
}

function asArray(v: unknown): unknown[] {
    if (v === undefined || v === null) { return []; }
    return Array.isArray(v) ? v : [v];
}

function attr(node: Record<string, unknown>, name: string): string | undefined {
    const value = node[`@_${name}`];
    return value === undefined || value === null ? undefined : String(value);
}
