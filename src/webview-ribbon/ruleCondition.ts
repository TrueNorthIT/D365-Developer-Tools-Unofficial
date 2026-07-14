import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// Structured editing for enable/display rule conditions, modeled against Microsoft's actual
// RibbonTypes.xsd schema (via the archived per-element CRM 2016 schema reference, which gives exact
// attribute names/enums -- the current Power Apps docs describe usage but are looser on precise
// attribute names for some of the more obscure types) rather than guessing from real captures alone.
//
// Crucially, EnableRule and DisplayRule do NOT accept the same set of condition types -- the schema
// restricts each condition element to specific parent(s). ENABLE_RULE_TYPES and DISPLAY_RULE_TYPES
// below encode that distinction directly, e.g. SelectionCountRule/RecordPrivilegeRule/CustomRule/
// OutlookItemTrackingRule are enable-only, while EntityPrivilegeRule/EntityPropertyRule/
// MiscellaneousPrivilegeRule/FormTypeRule/OrganizationSettingRule/etc. are display-only. A handful
// (CrmClientTypeRule, CommandClientTypeRule, EntityRule, FormStateRule, OutlookVersionRule, PageRule,
// SkuRule, ValueRule) are valid in both.
//
// OrRule is the schema's composite: `<EnableRule Id="..."><OrRule><Or>…leaf conditions…</Or></OrRule>`
// evaluates true if ANY nested condition does (overriding the schema's normal implicit AND across
// multiple rules). Modeled one level deep -- `<Or>` holds leaf conditions, not further OrRules (the
// schema doesn't nest OrRule inside Or either).
//
// Not modeled: OptionSetRule (Microsoft docs mark it "for internal use only"), and
// CrmOutlookClientVersionRule (mentioned in the current Power Apps docs but absent from the
// canonical schema reference's DisplayRule child-element list -- dropped rather than guess at
// unverified attribute names). Both, along with anything else unrecognized -- or a rule with
// multiple sibling conditions that ISN'T wrapped in an OrRule (an undocumented/malformed shape) --
// fall back to `Raw`, the same free-text XML editing this dialog always had.
export type RibbonRuleLeafConditionType =
    | 'CommandClientTypeRule' | 'CrmClientTypeRule' | 'CrmOfflineAccessStateRule' | 'CrmOutlookClientTypeRule'
    | 'CustomRule' | 'EntityRule' | 'FormStateRule' | 'OutlookItemTrackingRule' | 'OutlookVersionRule' | 'PageRule'
    | 'RecordPrivilegeRule' | 'SelectionCountRule' | 'SkuRule' | 'ValueRule'
    | 'EntityPrivilegeRule' | 'EntityPropertyRule' | 'FormEntityContextRule' | 'FormTypeRule'
    | 'HideForTabletExperienceRule' | 'MiscellaneousPrivilegeRule' | 'OrganizationSettingRule'
    | 'OutlookRenderTypeRule' | 'ReferencingAttributeRequiredRule' | 'RelationshipTypeRule';

export type RibbonRuleConditionType = RibbonRuleLeafConditionType | 'OrRule' | 'Raw';

interface Base {
    invertResult: boolean;
    /** Any attribute this editor doesn't have a dedicated field for (e.g. the rarely hand-set
     *  `Default` fallback-value attribute every rule type supports) -- preserved verbatim on
     *  serialize so nothing is silently dropped just because there's no UI control for it. */
    otherAttrs: Record<string, string>;
}

export type RibbonRuleLeafCondition =
    | ({ type: 'CommandClientTypeRule'; presentationType: string } & Base)
    | ({ type: 'CrmClientTypeRule'; clientType: string } & Base)
    | ({ type: 'CrmOfflineAccessStateRule'; state: string } & Base)
    | ({ type: 'CrmOutlookClientTypeRule'; outlookClientType: string } & Base)
    | ({ type: 'CustomRule'; library: string; functionName: string; params: string[] } & Base)
    | ({ type: 'EntityRule'; entityName: string; context: string; appliesTo: string } & Base)
    | ({ type: 'FormStateRule'; state: string } & Base)
    | ({ type: 'OutlookItemTrackingRule'; trackedInCrm: boolean } & Base)
    | ({ type: 'OutlookVersionRule'; version: string } & Base)
    | ({ type: 'PageRule'; address: string } & Base)
    | ({ type: 'RecordPrivilegeRule'; privilegeType: string } & Base)
    | ({ type: 'SelectionCountRule'; minimum: string; maximum: string; appliesTo: string } & Base)
    | ({ type: 'SkuRule'; sku: string } & Base)
    | ({ type: 'ValueRule'; field: string; value: string } & Base)
    | ({ type: 'EntityPrivilegeRule'; entityName: string; appliesTo: string; privilegeType: string; privilegeDepth: string } & Base)
    | ({ type: 'EntityPropertyRule'; entityName: string; appliesTo: string; propertyName: string; propertyValue: string } & Base)
    | ({ type: 'FormEntityContextRule'; entityName: string } & Base)
    | ({ type: 'FormTypeRule'; formType: string } & Base)
    | ({ type: 'HideForTabletExperienceRule' } & Base)
    | ({ type: 'MiscellaneousPrivilegeRule'; privilegeName: string; privilegeDepth: string } & Base)
    | ({ type: 'OrganizationSettingRule'; setting: string } & Base)
    | ({ type: 'OutlookRenderTypeRule'; renderType: string } & Base)
    | ({ type: 'ReferencingAttributeRequiredRule' } & Base)
    | ({ type: 'RelationshipTypeRule'; relationshipType: string } & Base);

export type RibbonRuleCondition =
    | RibbonRuleLeafCondition
    | { type: 'OrRule'; conditions: RibbonRuleLeafCondition[] }
    | { type: 'Raw'; xml: string };

export const LEAF_CONDITION_TYPES: RibbonRuleLeafConditionType[] = [
    'CommandClientTypeRule', 'CrmClientTypeRule', 'CrmOfflineAccessStateRule', 'CrmOutlookClientTypeRule',
    'CustomRule', 'EntityRule', 'FormStateRule', 'OutlookItemTrackingRule', 'OutlookVersionRule', 'PageRule',
    'RecordPrivilegeRule', 'SelectionCountRule', 'SkuRule', 'ValueRule',
    'EntityPrivilegeRule', 'EntityPropertyRule', 'FormEntityContextRule', 'FormTypeRule',
    'HideForTabletExperienceRule', 'MiscellaneousPrivilegeRule', 'OrganizationSettingRule',
    'OutlookRenderTypeRule', 'ReferencingAttributeRequiredRule', 'RelationshipTypeRule',
];
export const RULE_CONDITION_TYPES: RibbonRuleConditionType[] = [...LEAF_CONDITION_TYPES, 'OrRule', 'Raw'];

// Per the schema, EnableRule and DisplayRule each accept a different subset of leaf condition types
// (both directly, and nested inside an OrRule's <Or>). OrRule and Raw are valid at the top level of
// either wrapper.
const ENABLE_LEAF_TYPES: RibbonRuleLeafConditionType[] = [
    'CommandClientTypeRule', 'CrmClientTypeRule', 'CrmOfflineAccessStateRule', 'CrmOutlookClientTypeRule',
    'CustomRule', 'EntityRule', 'FormStateRule', 'OutlookItemTrackingRule', 'OutlookVersionRule', 'PageRule',
    'RecordPrivilegeRule', 'SelectionCountRule', 'SkuRule', 'ValueRule',
];
const DISPLAY_LEAF_TYPES: RibbonRuleLeafConditionType[] = [
    'CommandClientTypeRule', 'CrmClientTypeRule', 'CrmOfflineAccessStateRule', 'CrmOutlookClientTypeRule',
    'EntityPrivilegeRule', 'EntityPropertyRule', 'EntityRule', 'FormEntityContextRule', 'FormStateRule',
    'FormTypeRule', 'HideForTabletExperienceRule', 'MiscellaneousPrivilegeRule', 'OrganizationSettingRule',
    'OutlookRenderTypeRule', 'OutlookVersionRule', 'PageRule', 'ReferencingAttributeRequiredRule',
    'RelationshipTypeRule', 'SkuRule', 'ValueRule',
];
export const ENABLE_RULE_TYPES: RibbonRuleConditionType[] = [...ENABLE_LEAF_TYPES, 'OrRule', 'Raw'];
export const DISPLAY_RULE_TYPES: RibbonRuleConditionType[] = [...DISPLAY_LEAF_TYPES, 'OrRule', 'Raw'];

export function ruleTypesFor(wrapperTag: 'EnableRule' | 'DisplayRule'): RibbonRuleConditionType[] {
    return wrapperTag === 'EnableRule' ? ENABLE_RULE_TYPES : DISPLAY_RULE_TYPES;
}

export function leafRuleTypesFor(wrapperTag: 'EnableRule' | 'DisplayRule'): RibbonRuleLeafConditionType[] {
    return wrapperTag === 'EnableRule' ? ENABLE_LEAF_TYPES : DISPLAY_LEAF_TYPES;
}

export const RULE_CONDITION_LABELS: Record<RibbonRuleConditionType, string> = {
    CommandClientTypeRule: 'Command Presentation Type',
    CrmClientTypeRule: 'Client Type',
    CrmOfflineAccessStateRule: 'Offline Access State',
    CrmOutlookClientTypeRule: 'Outlook Client Type',
    CustomRule: 'Custom (JavaScript)',
    EntityRule: 'Current Entity',
    FormStateRule: 'Form State',
    OutlookItemTrackingRule: 'Outlook Item Tracking',
    OutlookVersionRule: 'Outlook Version',
    PageRule: 'Page Address',
    RecordPrivilegeRule: 'Record Privilege',
    SelectionCountRule: 'Selection Count',
    SkuRule: 'Dataverse Edition (SKU)',
    ValueRule: 'Field Value',
    EntityPrivilegeRule: 'Entity Privilege',
    EntityPropertyRule: 'Entity Property',
    FormEntityContextRule: 'Form Entity Context',
    FormTypeRule: 'Form Type',
    HideForTabletExperienceRule: 'Hide On Tablet',
    MiscellaneousPrivilegeRule: 'Miscellaneous Privilege',
    OrganizationSettingRule: 'Organization Setting',
    OutlookRenderTypeRule: 'Outlook Render Type',
    ReferencingAttributeRequiredRule: 'Referencing Attribute Required',
    RelationshipTypeRule: 'Relationship Type',
    OrRule: 'Any Of (Or)',
    Raw: 'Raw XML / Other',
};

export function ruleConditionLabel(condition: RibbonRuleCondition): string {
    return RULE_CONDITION_LABELS[condition.type];
}

// ── Enum value lists for dropdown fields (all sourced from the schema reference) ────────────────
export const COMMAND_CLIENT_TYPES = ['Modern', 'Refresh', 'Legacy'];
export const CLIENT_TYPES = ['Web', 'Outlook'];
export const OFFLINE_ACCESS_STATES = ['Online', 'Offline'];
export const OUTLOOK_CLIENT_TYPES = ['CrmForOutlook', 'CrmForOutlookOfflineAccess'];
export const ENTITY_RULE_CONTEXTS = ['', 'Form', 'HomePageGrid', 'SubGridStandard', 'SubGridAssociated'];
export const APPLIES_TO_OPTIONS = ['', 'PrimaryEntity', 'SelectedEntity'];
export const FORM_STATES = ['Create', 'Existing', 'ReadOnly', 'Disabled', 'BulkEdit'];
export const OUTLOOK_VERSIONS = ['2003', '2007', '2010'];
export const PRIVILEGE_TYPES = ['Create', 'Read', 'Write', 'Delete', 'Assign', 'Share', 'Append', 'AppendTo'];
export const PRIVILEGE_DEPTHS_WITH_NONE = ['None', 'Basic', 'Local', 'Deep', 'Global'];
export const PRIVILEGE_DEPTHS = ['', 'Basic', 'Local', 'Deep', 'Global'];
export const SKUS = ['OnPremise', 'Online', 'Spla'];
export const ENTITY_PROPERTY_NAMES = [
    'DuplicateDetectionEnabled', 'GridFiltersEnabled', 'HasStateCode', 'IsConnectionsEnabled', 'MailMergeEnabled',
    'WorksWithQueue', 'HasActivities', 'IsActivity', 'IsBusinessProcessEnabled', 'HasNotes', 'IsCustomizable',
];
export const FORM_TYPES = ['Main', 'Preview', 'AppointmentBook', 'Dashboard', 'Quick', 'QuickCreate', 'Card', 'MainInteractionCentric'];
export const ORGANIZATION_SETTINGS = ['IsSharepointEnabled', 'IsSOPIntegrationEnabled', 'IsFiscalCalendarDefined'];
export const RELATIONSHIP_TYPES = ['OneToMany', 'ManyToMany', 'NoRelationship'];

export function defaultLeafCondition(type: RibbonRuleLeafConditionType): RibbonRuleLeafCondition {
    const base = { invertResult: false, otherAttrs: {} };
    switch (type) {
        case 'CommandClientTypeRule': return { type, presentationType: 'Refresh', ...base };
        case 'CrmClientTypeRule': return { type, clientType: 'Web', ...base };
        case 'CrmOfflineAccessStateRule': return { type, state: 'Online', ...base };
        case 'CrmOutlookClientTypeRule': return { type, outlookClientType: 'CrmForOutlook', ...base };
        case 'CustomRule': return { type, library: '', functionName: '', params: [], ...base };
        case 'EntityRule': return { type, entityName: '', context: '', appliesTo: '', ...base };
        case 'FormStateRule': return { type, state: 'Create', ...base };
        case 'OutlookItemTrackingRule': return { type, trackedInCrm: true, ...base };
        case 'OutlookVersionRule': return { type, version: '2010', ...base };
        case 'PageRule': return { type, address: '', ...base };
        case 'RecordPrivilegeRule': return { type, privilegeType: 'Read', ...base };
        case 'SelectionCountRule': return { type, minimum: '1', maximum: '1', appliesTo: '', ...base };
        case 'SkuRule': return { type, sku: 'Online', ...base };
        case 'ValueRule': return { type, field: '', value: '', ...base };
        case 'EntityPrivilegeRule': return { type, entityName: '', appliesTo: '', privilegeType: 'Read', privilegeDepth: 'Basic', ...base };
        case 'EntityPropertyRule': return { type, entityName: '', appliesTo: '', propertyName: 'HasNotes', propertyValue: '', ...base };
        case 'FormEntityContextRule': return { type, entityName: '', ...base };
        case 'FormTypeRule': return { type, formType: 'Main', ...base };
        case 'HideForTabletExperienceRule': return { type, ...base };
        case 'MiscellaneousPrivilegeRule': return { type, privilegeName: '', privilegeDepth: '', ...base };
        case 'OrganizationSettingRule': return { type, setting: 'IsSharepointEnabled', ...base };
        case 'OutlookRenderTypeRule': return { type, renderType: 'Web', ...base };
        case 'ReferencingAttributeRequiredRule': return { type, ...base };
        case 'RelationshipTypeRule': return { type, relationshipType: 'OneToMany', ...base };
    }
}

export function defaultRuleCondition(type: RibbonRuleConditionType): RibbonRuleCondition {
    if (type === 'Raw') { return { type: 'Raw', xml: '' }; }
    // Seeded with one starter condition rather than an empty group -- an empty <Or/> isn't a
    // meaningful rule (parseRuleCondition treats it as Raw, since the schema doesn't really allow
    // for it either), so defaulting to an empty array here would make "switch to Any Of (Or)"
    // silently produce something that immediately falls back out of structured editing.
    // CrmClientTypeRule is valid inside Or regardless of wrapper (EnableRule or DisplayRule).
    if (type === 'OrRule') { return { type: 'OrRule', conditions: [defaultLeafCondition('CrmClientTypeRule')] }; }
    return defaultLeafCondition(type);
}

const ARRAY_TAGS = new Set(['CrmParameter', 'StringParameter']);

function makeParser(): XMLParser {
    return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: false, isArray: name => ARRAY_TAGS.has(name) });
}

// suppressBooleanAttributes defaults to true in fast-xml-parser, which renders an attribute whose
// value is the string "true" as a bare, value-less attribute (e.g. `InvertResult` instead of
// `InvertResult="true"`) -- fine for genuine HTML-style boolean attributes, wrong here since every
// attribute in this schema is a real string/enum value.
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressEmptyNode: true, suppressBooleanAttributes: false });

function parseBool(v: string | undefined): boolean {
    return v === 'true' || v === '1';
}

// Normalizes a fast-xml-parser child value into an attribute-bag object, or undefined if it's a
// shape this editor can't safely treat as one leaf condition node (an array -- multiple sibling
// elements of the same tag -- or a non-object/non-empty-string value). A fully empty self-closing
// element (no attributes, no children, e.g. <HideForTabletExperienceRule />) parses as an empty
// string rather than {} -- normalized to {} here.
function asAttrNode(raw: unknown): Record<string, unknown> | undefined {
    if (raw === '' || raw === null || raw === undefined) { return {}; }
    if (typeof raw === 'object' && !Array.isArray(raw)) { return raw as Record<string, unknown>; }
    return undefined;
}

// Parses one <TagName ...attrs.../> node into a leaf condition, or undefined if `tag` isn't a
// recognized leaf type or the node's shape doesn't match what the schema documents for it (extra
// child elements where none are expected, an unmodeled CustomRule parameter type, etc).
function parseLeafConditionNode(tag: string, node: Record<string, unknown>): RibbonRuleLeafCondition | undefined {
    const attr = (name: string): string | undefined => {
        const v = node[`@_${name}`];
        return v === undefined || v === null ? undefined : String(v);
    };
    const invertResult = parseBool(attr('InvertResult'));
    const otherAttrsExcluding = (...names: string[]): Record<string, string> => {
        const extra: Record<string, string> = {};
        for (const key of Object.keys(node)) {
            if (!key.startsWith('@_')) { continue; }
            const name = key.slice(2);
            if (name === 'InvertResult' || names.includes(name)) { continue; }
            extra[name] = String(node[key]);
        }
        return extra;
    };
    // None of these condition types have child elements per the schema except CustomRule -- if one
    // shows up anyway (unexpected/unmodeled XML), don't risk silently dropping it.
    const hasChildElements = Object.keys(node).some(k => !k.startsWith('@_'));

    switch (tag) {
        case 'CommandClientTypeRule':
            if (hasChildElements) { return undefined; }
            return { type: 'CommandClientTypeRule', presentationType: attr('Type') ?? 'Refresh', invertResult, otherAttrs: otherAttrsExcluding('Type') };
        case 'CrmClientTypeRule':
            if (hasChildElements) { return undefined; }
            return { type: 'CrmClientTypeRule', clientType: attr('Type') ?? 'Web', invertResult, otherAttrs: otherAttrsExcluding('Type') };
        case 'CrmOfflineAccessStateRule':
            if (hasChildElements) { return undefined; }
            return { type: 'CrmOfflineAccessStateRule', state: attr('State') ?? 'Online', invertResult, otherAttrs: otherAttrsExcluding('State') };
        case 'CrmOutlookClientTypeRule':
            if (hasChildElements) { return undefined; }
            return { type: 'CrmOutlookClientTypeRule', outlookClientType: attr('Type') ?? 'CrmForOutlook', invertResult, otherAttrs: otherAttrsExcluding('Type') };
        case 'CustomRule': {
            // Bool/Decimal/Int params aren't modeled (see params below) -- if any show up, bail
            // rather than silently discarding them on the next save.
            if (node.BoolParameter !== undefined || node.DecimalParameter !== undefined || node.IntParameter !== undefined) {
                return undefined;
            }
            const params: string[] = [];
            for (const key of ['CrmParameter', 'StringParameter']) {
                for (const p of ((node[key] as unknown[] | undefined) ?? [])) {
                    const value = (p as Record<string, unknown>)['@_Value'];
                    params.push(value === undefined || value === null ? '' : String(value));
                }
            }
            return {
                type: 'CustomRule',
                library: attr('Library') ?? '',
                functionName: attr('FunctionName') ?? '',
                params,
                invertResult,
                otherAttrs: otherAttrsExcluding('Library', 'FunctionName'),
            };
        }
        case 'EntityRule':
            if (hasChildElements) { return undefined; }
            return {
                type: 'EntityRule',
                entityName: attr('EntityName') ?? '',
                context: attr('Context') ?? '',
                appliesTo: attr('AppliesTo') ?? '',
                invertResult,
                otherAttrs: otherAttrsExcluding('EntityName', 'Context', 'AppliesTo'),
            };
        case 'FormStateRule':
            if (hasChildElements) { return undefined; }
            return { type: 'FormStateRule', state: attr('State') ?? 'Create', invertResult, otherAttrs: otherAttrsExcluding('State') };
        case 'OutlookItemTrackingRule':
            if (hasChildElements) { return undefined; }
            return { type: 'OutlookItemTrackingRule', trackedInCrm: parseBool(attr('TrackedInCrm')), invertResult, otherAttrs: otherAttrsExcluding('TrackedInCrm', 'AppliesTo') };
        case 'OutlookVersionRule':
            if (hasChildElements) { return undefined; }
            return { type: 'OutlookVersionRule', version: attr('Version') ?? '2010', invertResult, otherAttrs: otherAttrsExcluding('Version') };
        case 'PageRule':
            if (hasChildElements) { return undefined; }
            return { type: 'PageRule', address: attr('Address') ?? '', invertResult, otherAttrs: otherAttrsExcluding('Address') };
        case 'RecordPrivilegeRule':
            if (hasChildElements) { return undefined; }
            return { type: 'RecordPrivilegeRule', privilegeType: attr('PrivilegeType') ?? 'Read', invertResult, otherAttrs: otherAttrsExcluding('PrivilegeType', 'AppliesTo') };
        case 'SelectionCountRule':
            if (hasChildElements) { return undefined; }
            return {
                type: 'SelectionCountRule',
                minimum: attr('Minimum') ?? '',
                maximum: attr('Maximum') ?? '',
                appliesTo: attr('AppliesTo') ?? '',
                invertResult,
                otherAttrs: otherAttrsExcluding('Minimum', 'Maximum', 'AppliesTo'),
            };
        case 'SkuRule':
            if (hasChildElements) { return undefined; }
            return { type: 'SkuRule', sku: attr('Sku') ?? 'Online', invertResult, otherAttrs: otherAttrsExcluding('Sku') };
        case 'ValueRule':
            if (hasChildElements) { return undefined; }
            return { type: 'ValueRule', field: attr('Field') ?? '', value: attr('Value') ?? '', invertResult, otherAttrs: otherAttrsExcluding('Field', 'Value') };
        case 'EntityPrivilegeRule':
            if (hasChildElements) { return undefined; }
            return {
                type: 'EntityPrivilegeRule',
                entityName: attr('EntityName') ?? '',
                appliesTo: attr('AppliesTo') ?? '',
                privilegeType: attr('PrivilegeType') ?? 'Read',
                privilegeDepth: attr('PrivilegeDepth') ?? 'Basic',
                invertResult,
                otherAttrs: otherAttrsExcluding('EntityName', 'AppliesTo', 'PrivilegeType', 'PrivilegeDepth'),
            };
        case 'EntityPropertyRule':
            if (hasChildElements) { return undefined; }
            return {
                type: 'EntityPropertyRule',
                entityName: attr('EntityName') ?? '',
                appliesTo: attr('AppliesTo') ?? '',
                propertyName: attr('PropertyName') ?? 'HasNotes',
                propertyValue: attr('PropertyValue') ?? '',
                invertResult,
                otherAttrs: otherAttrsExcluding('EntityName', 'AppliesTo', 'PropertyName', 'PropertyValue'),
            };
        case 'FormEntityContextRule':
            if (hasChildElements) { return undefined; }
            return { type: 'FormEntityContextRule', entityName: attr('EntityName') ?? '', invertResult, otherAttrs: otherAttrsExcluding('EntityName') };
        case 'FormTypeRule':
            if (hasChildElements) { return undefined; }
            return { type: 'FormTypeRule', formType: attr('Type') ?? 'Main', invertResult, otherAttrs: otherAttrsExcluding('Type') };
        case 'HideForTabletExperienceRule':
            if (hasChildElements) { return undefined; }
            return { type: 'HideForTabletExperienceRule', invertResult, otherAttrs: otherAttrsExcluding() };
        case 'MiscellaneousPrivilegeRule':
            if (hasChildElements) { return undefined; }
            return {
                type: 'MiscellaneousPrivilegeRule',
                privilegeName: attr('PrivilegeName') ?? '',
                privilegeDepth: attr('PrivilegeDepth') ?? '',
                invertResult,
                otherAttrs: otherAttrsExcluding('PrivilegeName', 'PrivilegeDepth'),
            };
        case 'OrganizationSettingRule':
            if (hasChildElements) { return undefined; }
            return { type: 'OrganizationSettingRule', setting: attr('Setting') ?? 'IsSharepointEnabled', invertResult, otherAttrs: otherAttrsExcluding('Setting') };
        case 'OutlookRenderTypeRule':
            if (hasChildElements) { return undefined; }
            return { type: 'OutlookRenderTypeRule', renderType: attr('Type') ?? 'Web', invertResult, otherAttrs: otherAttrsExcluding('Type') };
        case 'ReferencingAttributeRequiredRule':
            if (hasChildElements) { return undefined; }
            return { type: 'ReferencingAttributeRequiredRule', invertResult, otherAttrs: otherAttrsExcluding() };
        case 'RelationshipTypeRule':
            if (hasChildElements) { return undefined; }
            return {
                type: 'RelationshipTypeRule',
                relationshipType: attr('RelationshipType') ?? 'OneToMany',
                invertResult,
                // AppliesTo is deliberately excluded too (not just RelationshipType): it's always
                // re-derived as the fixed "SelectedEntity" on serialize (the only documented
                // value), so letting it flow into otherAttrs would make every parse -> serialize ->
                // parse round-trip pick up a stray otherAttrs entry. AllowCustomRelationship/
                // AllowSystemRelationship have no dedicated field, so those genuinely do need
                // otherAttrs to survive a round-trip.
                otherAttrs: otherAttrsExcluding('RelationshipType', 'AppliesTo'),
            };
        default:
            return undefined;
    }
}

function parseOrRule(rawOrRuleNode: unknown, xml: string): RibbonRuleCondition {
    const orRuleNode = asAttrNode(rawOrRuleNode);
    if (!orRuleNode) { return { type: 'Raw', xml }; }

    // <OrRule> has no attributes of its own and exactly one child, <Or>.
    const orRuleKeys = Object.keys(orRuleNode).filter(k => !k.startsWith('@_'));
    if (orRuleKeys.length !== 1 || orRuleKeys[0] !== 'Or') { return { type: 'Raw', xml }; }

    const orNode = asAttrNode(orRuleNode.Or);
    if (!orNode) { return { type: 'Raw', xml }; }

    const conditions: RibbonRuleLeafCondition[] = [];
    for (const key of Object.keys(orNode)) {
        if (key.startsWith('@_')) { return { type: 'Raw', xml }; } // <Or> has no attributes per schema
        const rawSiblings = orNode[key];
        const siblings = Array.isArray(rawSiblings) ? rawSiblings : [rawSiblings];
        for (const rawSibling of siblings) {
            const node = asAttrNode(rawSibling);
            const leaf = node && parseLeafConditionNode(key, node);
            // Any single nested condition we can't structurally represent bails the *whole* OrRule
            // to Raw, rather than silently dropping just that one branch of the OR.
            if (!leaf) { return { type: 'Raw', xml }; }
            conditions.push(leaf);
        }
    }
    if (conditions.length === 0) { return { type: 'Raw', xml }; } // an empty Or is unusual/invalid

    return { type: 'OrRule', conditions };
}

// `xml` is a full `<EnableRule Id="...">…</EnableRule>` (or DisplayRule) fragment -- the shape
// RibbonRuleRaw.xml is always stored in.
export function parseRuleCondition(xml: string): RibbonRuleCondition {
    try {
        const doc = makeParser().parse(xml) as Record<string, unknown>;
        const wrapperKey = Object.keys(doc)[0];
        const wrapper = doc[wrapperKey] as Record<string, unknown> | undefined;
        if (!wrapper || typeof wrapper !== 'object') { return { type: 'Raw', xml }; }

        // Exactly one child element expected (the single condition -- possibly an OrRule wrapping
        // several -- this EnableRule/DisplayRule holds). Zero means an empty/unrecognized body;
        // more than one (outside of OrRule) means an implicit multi-condition AND this editor
        // doesn't model structurally.
        const childKeys = Object.keys(wrapper).filter(k => !k.startsWith('@_'));
        if (childKeys.length !== 1) { return { type: 'Raw', xml }; }

        const conditionKey = childKeys[0];
        const rawNode = wrapper[conditionKey];

        if (conditionKey === 'OrRule') { return parseOrRule(rawNode, xml); }

        const node = asAttrNode(rawNode);
        const leaf = node && parseLeafConditionNode(conditionKey, node);
        return leaf ?? { type: 'Raw', xml };
    } catch {
        return { type: 'Raw', xml };
    }
}

function leafConditionAttrs(condition: RibbonRuleLeafCondition): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(condition.otherAttrs)) { attrs[`@_${name}`] = value; }

    switch (condition.type) {
        case 'CommandClientTypeRule': attrs['@_Type'] = condition.presentationType; break;
        case 'CrmClientTypeRule': attrs['@_Type'] = condition.clientType; break;
        case 'CrmOfflineAccessStateRule': attrs['@_State'] = condition.state; break;
        case 'CrmOutlookClientTypeRule': attrs['@_Type'] = condition.outlookClientType; break;
        case 'CustomRule':
            attrs['@_Library'] = condition.library;
            attrs['@_FunctionName'] = condition.functionName;
            // Matches ribbonXmlBuilder.ts's own JavaScriptFunction action serialization -- always
            // re-emitted as CrmParameter regardless of whether the original was a StringParameter,
            // a simplification already accepted there for the same reason (no way to know from a
            // plain string[] which the source used).
            if (condition.params.length) { attrs.CrmParameter = condition.params.map(v => ({ '@_Value': v })); }
            break;
        case 'EntityRule':
            attrs['@_EntityName'] = condition.entityName;
            if (condition.context) { attrs['@_Context'] = condition.context; }
            if (condition.appliesTo) { attrs['@_AppliesTo'] = condition.appliesTo; }
            break;
        case 'FormStateRule': attrs['@_State'] = condition.state; break;
        case 'OutlookItemTrackingRule': attrs['@_TrackedInCrm'] = condition.trackedInCrm ? 'true' : 'false'; break;
        case 'OutlookVersionRule': attrs['@_Version'] = condition.version; break;
        case 'PageRule': attrs['@_Address'] = condition.address; break;
        case 'RecordPrivilegeRule': attrs['@_PrivilegeType'] = condition.privilegeType; break;
        case 'SelectionCountRule':
            if (condition.minimum) { attrs['@_Minimum'] = condition.minimum; }
            if (condition.maximum) { attrs['@_Maximum'] = condition.maximum; }
            if (condition.appliesTo) { attrs['@_AppliesTo'] = condition.appliesTo; }
            break;
        case 'SkuRule': attrs['@_Sku'] = condition.sku; break;
        case 'ValueRule': attrs['@_Field'] = condition.field; attrs['@_Value'] = condition.value; break;
        case 'EntityPrivilegeRule':
            if (condition.entityName) { attrs['@_EntityName'] = condition.entityName; }
            if (condition.appliesTo) { attrs['@_AppliesTo'] = condition.appliesTo; }
            attrs['@_PrivilegeType'] = condition.privilegeType;
            attrs['@_PrivilegeDepth'] = condition.privilegeDepth;
            break;
        case 'EntityPropertyRule':
            if (condition.entityName) { attrs['@_EntityName'] = condition.entityName; }
            if (condition.appliesTo) { attrs['@_AppliesTo'] = condition.appliesTo; }
            attrs['@_PropertyName'] = condition.propertyName;
            if (condition.propertyValue) { attrs['@_PropertyValue'] = condition.propertyValue; }
            break;
        case 'FormEntityContextRule': attrs['@_EntityName'] = condition.entityName; break;
        case 'FormTypeRule': attrs['@_Type'] = condition.formType; break;
        case 'HideForTabletExperienceRule': break;
        case 'MiscellaneousPrivilegeRule':
            attrs['@_PrivilegeName'] = condition.privilegeName;
            if (condition.privilegeDepth) { attrs['@_PrivilegeDepth'] = condition.privilegeDepth; }
            break;
        case 'OrganizationSettingRule': attrs['@_Setting'] = condition.setting; break;
        case 'OutlookRenderTypeRule': attrs['@_Type'] = condition.renderType; break;
        case 'ReferencingAttributeRequiredRule': break;
        case 'RelationshipTypeRule':
            attrs['@_RelationshipType'] = condition.relationshipType;
            attrs['@_AppliesTo'] = 'SelectedEntity'; // the only documented value; required by schema
            break;
    }
    if (condition.invertResult) { attrs['@_InvertResult'] = 'true'; }
    return attrs;
}

export function serializeRuleCondition(id: string, wrapperTag: 'EnableRule' | 'DisplayRule', condition: RibbonRuleCondition): string {
    if (condition.type === 'Raw') { return condition.xml; }

    if (condition.type === 'OrRule') {
        const orChildren: Record<string, unknown[]> = {};
        for (const leaf of condition.conditions) {
            (orChildren[leaf.type] ??= []).push(leafConditionAttrs(leaf));
        }
        return builder.build({ [wrapperTag]: { '@_Id': id, OrRule: { Or: orChildren } } }) as string;
    }

    return builder.build({ [wrapperTag]: { '@_Id': id, [condition.type]: leafConditionAttrs(condition) } }) as string;
}
