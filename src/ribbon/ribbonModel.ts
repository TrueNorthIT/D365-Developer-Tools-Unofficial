// Plain, JSON-serializable model of a Dataverse ribbon — shared shape between the extension host
// (parses/builds it) and the ribbon editor webview (renders/edits it as plain data, no XML awareness).
// Kept dependency-free so it can be imported by both sides without pulling in `vscode` or an XML lib.

// 'reverted' only ever applies to a control -- see RibbonControl.status and ribbonState.ts's
// removeCustomization for what it means and why it's a distinct thing from 'deleted'.
export type RibbonNodeStatus = 'unchanged' | 'added' | 'modified' | 'deleted' | 'reverted';

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
    /** This control's Sequence attribute in the merged/effective ribbon -- its position relative to
     *  sibling controls in the same group. Preserved verbatim through an edit that doesn't reorder
     *  anything (see buildRibbonDiffFragments in ribbonXmlBuilder.ts); reorderControl (ribbonState.ts)
     *  is the only thing that ever assigns a new value, to reflect a drag-and-drop move. Undefined for
     *  a control added this session, which has no position of its own yet. */
    sequence?: string;
    /** FlyoutAnchor > Menu > MenuSection > Controls, or a MenuSection's own Controls. */
    controls?: RibbonControl[];
    /** 'reverted' means "strip any existing CustomAction(s) declaring this element -- this tool's
     *  own, another tool's, doesn't matter -- but do NOT hide it": the underlying base/OOB definition
     *  shows through untouched, same as if it had never been customized at all. Deliberately distinct
     *  from 'deleted' (which does the same stripping AND adds an explicit HideCustomAction) -- Ribbon
     *  Workbench's own "Delete" (for an already-customized element) only does the former, which
     *  confirmed-live turned out NOT to hide anything, just revert to the OOB default appearing
     *  again. This tool exposes both as separate actions rather than conflating them: "hide this" and
     *  "remove whatever customization(s) exist for this, whoever made them" are genuinely different
     *  intents. See removeCustomization (ribbonState.ts). */
    status: RibbonNodeStatus;
}

export interface RibbonGroup {
    id: string;
    title: string;
    /** See RibbonControl.sequence -- same idea, one level up (position among sibling groups in a tab). */
    sequence?: string;
    /** This group's Template attribute (e.g. "Mscrm.Templates.Flexible2") -- every real group in the
     *  effective ribbon carries one; it's what actually gives a group's Controls somewhere to render
     *  into. Preserved verbatim for an existing group re-serialized on edit/move; undefined for a
     *  group added this session, which has no original to preserve -- see buildRibbonDiffFragments'
     *  groupToObj, which falls back to a known-good default only in that case. */
    template?: string;
    /** This group's own Command attribute -- gates the group's own visibility/enablement, distinct
     *  from any individual control's Command. Same preserve-or-default treatment as `template`. */
    command?: string;
    controls: RibbonControl[];
    status: RibbonNodeStatus;
}

export interface RibbonTab {
    id: string;
    title: string;
    /** See RibbonControl.sequence -- same idea, one level up (position among sibling tabs). */
    sequence?: string;
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
