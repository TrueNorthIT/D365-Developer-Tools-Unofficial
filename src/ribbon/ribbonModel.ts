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

export type RibbonAction =
    | { type: 'JavaScriptFunction'; library: string; functionName: string; params: string[] }
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
