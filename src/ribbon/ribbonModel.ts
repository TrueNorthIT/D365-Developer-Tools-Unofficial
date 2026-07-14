// Plain, JSON-serializable model of a Dataverse ribbon — shared shape between the extension host
// (parses/builds it) and the ribbon editor webview (renders/edits it as plain data, no XML awareness).
// Kept dependency-free so it can be imported by both sides without pulling in `vscode` or an XML lib.

export type RibbonNodeStatus = 'unchanged' | 'added' | 'modified' | 'deleted';

export interface RibbonControl {
    kind: 'Button' | 'SplitButton' | 'FlyoutAnchor' | 'MenuSection';
    id: string;
    label: string;
    toolTipTitle: string;
    toolTipDescription: string;
    image16?: string;
    image32?: string;
    /** A named icon reference for the modern (Unified Interface) command bar. Resolved the same way
     *  as image16/image32 -- either a `$webresource:` reference or a bare web resource name -- but
     *  most values are one of Dataverse's built-in Fluent icon names, which don't match any web
     *  resource and simply have no icon to show. */
    modernImage?: string;
    commandId?: string;
    /** FlyoutAnchor > Menu > MenuSection > Controls, or a MenuSection's own Controls. */
    controls?: RibbonControl[];
    status: RibbonNodeStatus;
}

export interface RibbonGroup {
    id: string;
    title: string;
    controls: RibbonControl[];
    status: RibbonNodeStatus;
}

export interface RibbonTab {
    id: string;
    title: string;
    groups: RibbonGroup[];
    status: RibbonNodeStatus;
}

// A JavaScriptFunction's parameter, per RibbonTypes.xsd's ParameterType group -- five possible
// child tags, each just a single Value attribute (no Name; that's only valid/required for a Url
// action's *named* query-string parameters, which aren't modeled here). Bool/Decimal/Int values
// are kept as strings too (matching how similarly numeric-ish fields elsewhere in this model, e.g.
// SelectionCountRule's minimum/maximum, are represented) -- simpler than round-tripping through an
// actual number/boolean and back for what's ultimately just an XML attribute string.
export type RibbonActionParameter =
    | { type: 'BoolParameter'; value: boolean }
    | { type: 'CrmParameter'; value: string }
    | { type: 'DecimalParameter'; value: string }
    | { type: 'IntParameter'; value: string }
    | { type: 'StringParameter'; value: string };

export type RibbonAction =
    | { type: 'JavaScriptFunction'; library: string; functionName: string; params: RibbonActionParameter[] }
    | { type: 'Url'; address: string }
    | { type: 'Raw'; xml: string };

export interface RibbonCommandDefinition {
    id: string;
    enableRules: string[];
    displayRules: string[];
    actions: RibbonAction[];
    status: RibbonNodeStatus;
}

/** An EnableRule/DisplayRule definition kept as an opaque XML fragment — edited as raw XML. */
export interface RibbonRuleRaw {
    id: string;
    xml: string;
    status: RibbonNodeStatus;
}

export interface RibbonModel {
    tabs: RibbonTab[];
    commandDefinitions: RibbonCommandDefinition[];
    enableRules: RibbonRuleRaw[];
    displayRules: RibbonRuleRaw[];
    /** LocLabel Id -> resolved display text (1033, falling back to the first available). */
    locLabels: Record<string, string>;
}
