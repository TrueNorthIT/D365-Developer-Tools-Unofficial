import * as assert from 'assert';
import {
    defaultLeafCondition,
    defaultRuleCondition,
    DISPLAY_RULE_TYPES,
    ENABLE_RULE_TYPES,
    leafRuleTypesFor,
    parseRuleCondition,
    ruleConditionLabel,
    ruleTypesFor,
    RULE_CONDITION_TYPES,
    serializeRuleCondition,
    type RibbonRuleCondition,
} from '../../src/webview-ribbon/ruleCondition';

describe('parseRuleCondition', () => {
    it('parses CommandClientTypeRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><CommandClientTypeRule Type="Modern" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'CommandClientTypeRule', presentationType: 'Modern', invertResult: false, otherAttrs: {} });
    });

    it('parses CrmClientTypeRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><CrmClientTypeRule Type="Outlook" InvertResult="true" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'CrmClientTypeRule', clientType: 'Outlook', invertResult: true, otherAttrs: {} });
    });

    it('parses CrmOfflineAccessStateRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><CrmOfflineAccessStateRule State="Offline" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'CrmOfflineAccessStateRule', state: 'Offline', invertResult: false, otherAttrs: {} });
    });

    it('parses CrmOutlookClientTypeRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><CrmOutlookClientTypeRule Type="CrmForOutlookOfflineAccess" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'CrmOutlookClientTypeRule', outlookClientType: 'CrmForOutlookOfflineAccess', invertResult: false, otherAttrs: {} });
    });

    it('parses CustomRule with mixed CrmParameter/StringParameter children, preserving order within each kind', () => {
        const xml = `<EnableRule Id="r1">
  <CustomRule Library="$webresource:new_lib.js" FunctionName="isEnabled">
    <CrmParameter Value="PrimaryControl" />
    <StringParameter Value="hello" />
  </CustomRule>
</EnableRule>`;
        const condition = parseRuleCondition(xml);
        assert.strictEqual(condition.type, 'CustomRule');
        if (condition.type === 'CustomRule') {
            assert.strictEqual(condition.library, '$webresource:new_lib.js');
            assert.strictEqual(condition.functionName, 'isEnabled');
            assert.deepStrictEqual(condition.params, ['PrimaryControl', 'hello']);
        }
    });

    it('falls back to Raw for CustomRule with a BoolParameter/DecimalParameter/IntParameter child (unmodeled param types)', () => {
        const xml = '<EnableRule Id="r1"><CustomRule Library="lib.js" FunctionName="f"><BoolParameter Value="true" /></CustomRule></EnableRule>';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });

    it('parses EntityRule with optional Context and AppliesTo', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><EntityRule EntityName="account" Context="HomePageGrid" AppliesTo="SelectedEntity" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'EntityRule', entityName: 'account', context: 'HomePageGrid', appliesTo: 'SelectedEntity', invertResult: false, otherAttrs: {} });
    });

    it('parses EntityRule without optional attributes as empty strings', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><EntityRule EntityName="account" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'EntityRule', entityName: 'account', context: '', appliesTo: '', invertResult: false, otherAttrs: {} });
    });

    it('parses FormStateRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><FormStateRule State="Existing" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'FormStateRule', state: 'Existing', invertResult: false, otherAttrs: {} });
    });

    it('parses OutlookItemTrackingRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><OutlookItemTrackingRule TrackedInCrm="true" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'OutlookItemTrackingRule', trackedInCrm: true, invertResult: false, otherAttrs: {} });
    });

    it('parses OutlookVersionRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><OutlookVersionRule Version="2007" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'OutlookVersionRule', version: '2007', invertResult: false, otherAttrs: {} });
    });

    it('parses PageRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><PageRule Address="/main.aspx" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'PageRule', address: '/main.aspx', invertResult: false, otherAttrs: {} });
    });

    it('parses RecordPrivilegeRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><RecordPrivilegeRule PrivilegeType="Delete" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'RecordPrivilegeRule', privilegeType: 'Delete', invertResult: false, otherAttrs: {} });
    });

    it('parses SelectionCountRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><SelectionCountRule Minimum="1" Maximum="2" AppliesTo="SelectedEntity" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'SelectionCountRule', minimum: '1', maximum: '2', appliesTo: 'SelectedEntity', invertResult: false, otherAttrs: {} });
    });

    it('parses SkuRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><SkuRule Sku="OnPremise" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'SkuRule', sku: 'OnPremise', invertResult: false, otherAttrs: {} });
    });

    it('parses ValueRule', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><ValueRule Field="statecode" Value="0" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'ValueRule', field: 'statecode', value: '0', invertResult: false, otherAttrs: {} });
    });

    it('parses EntityPrivilegeRule', () => {
        const condition = parseRuleCondition(
            '<DisplayRule Id="r1"><EntityPrivilegeRule EntityName="account" PrivilegeType="Write" PrivilegeDepth="Deep" /></DisplayRule>',
        );
        assert.deepStrictEqual(condition, {
            type: 'EntityPrivilegeRule', entityName: 'account', appliesTo: '', privilegeType: 'Write', privilegeDepth: 'Deep', invertResult: false, otherAttrs: {},
        });
    });

    it('parses EntityPropertyRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><EntityPropertyRule EntityName="account" PropertyName="HasNotes" PropertyValue="true" /></DisplayRule>');
        assert.deepStrictEqual(condition, {
            type: 'EntityPropertyRule', entityName: 'account', appliesTo: '', propertyName: 'HasNotes', propertyValue: 'true', invertResult: false, otherAttrs: {},
        });
    });

    it('parses FormEntityContextRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><FormEntityContextRule EntityName="contact" InvertResult="true" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'FormEntityContextRule', entityName: 'contact', invertResult: true, otherAttrs: {} });
    });

    it('parses FormTypeRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><FormTypeRule Type="QuickCreate" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'FormTypeRule', formType: 'QuickCreate', invertResult: false, otherAttrs: {} });
    });

    it('parses HideForTabletExperienceRule (no extra attributes)', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><HideForTabletExperienceRule InvertResult="true" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'HideForTabletExperienceRule', invertResult: true, otherAttrs: {} });
    });

    it('parses MiscellaneousPrivilegeRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><MiscellaneousPrivilegeRule PrivilegeName="ExportToExcel" PrivilegeDepth="Global" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'MiscellaneousPrivilegeRule', privilegeName: 'ExportToExcel', privilegeDepth: 'Global', invertResult: false, otherAttrs: {} });
    });

    it('parses OrganizationSettingRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><OrganizationSettingRule Setting="IsFiscalCalendarDefined" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'OrganizationSettingRule', setting: 'IsFiscalCalendarDefined', invertResult: false, otherAttrs: {} });
    });

    it('parses OutlookRenderTypeRule', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><OutlookRenderTypeRule Type="Outlook" /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'OutlookRenderTypeRule', renderType: 'Outlook', invertResult: false, otherAttrs: {} });
    });

    it('parses ReferencingAttributeRequiredRule (no extra attributes)', () => {
        const condition = parseRuleCondition('<DisplayRule Id="r1"><ReferencingAttributeRequiredRule /></DisplayRule>');
        assert.deepStrictEqual(condition, { type: 'ReferencingAttributeRequiredRule', invertResult: false, otherAttrs: {} });
    });

    it('parses RelationshipTypeRule, preserving AppliesTo/AllowXRelationship via otherAttrs', () => {
        const condition = parseRuleCondition(
            '<DisplayRule Id="r1"><RelationshipTypeRule RelationshipType="ManyToMany" AppliesTo="SelectedEntity" AllowCustomRelationship="true" /></DisplayRule>',
        );
        assert.strictEqual(condition.type, 'RelationshipTypeRule');
        if (condition.type === 'RelationshipTypeRule') {
            assert.strictEqual(condition.relationshipType, 'ManyToMany');
            assert.strictEqual(condition.otherAttrs.AllowCustomRelationship, 'true');
            assert.strictEqual(condition.otherAttrs.AppliesTo, undefined, 'AppliesTo is always re-derived on serialize, not preserved as a free attribute');
        }
    });

    it('preserves unrecognized attributes via otherAttrs', () => {
        const condition = parseRuleCondition('<EnableRule Id="r1"><CrmClientTypeRule Type="Web" Default="true" /></EnableRule>');
        assert.deepStrictEqual(condition, { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: false, otherAttrs: { Default: 'true' } });
    });

    it('falls back to Raw for an unrecognized condition tag (e.g. an out-of-box-only or composite type)', () => {
        for (const tag of ['FeatureControlRule', 'OrRule', 'OptionSetRule']) {
            const xml = `<EnableRule Id="r1"><${tag} /></EnableRule>`;
            assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml }, `expected ${tag} to fall back to Raw`);
        }
    });

    it('falls back to Raw for a rule with multiple sibling conditions (implicit AND)', () => {
        const xml = '<EnableRule Id="r1"><FormStateRule State="Create" /><CrmClientTypeRule Type="Web" /></EnableRule>';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });

    it('falls back to Raw for a rule with multiple conditions of the same tag', () => {
        const xml = '<EnableRule Id="r1"><CrmClientTypeRule Type="Web" /><CrmClientTypeRule Type="Mobile" /></EnableRule>';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });

    it('falls back to Raw for an empty rule body', () => {
        const xml = '<EnableRule Id="r1">\n</EnableRule>';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });

    it('falls back to Raw for malformed XML rather than throwing', () => {
        const xml = '<EnableRule Id="r1"><Unclosed';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });
});

describe('parseRuleCondition: OrRule', () => {
    it('parses an OrRule with two different nested condition types, each in its own <Or>', () => {
        const xml = `<EnableRule Id="r1">
  <OrRule>
    <Or>
      <CrmClientTypeRule Type="Web" />
    </Or>
    <Or>
      <FormStateRule State="Create" InvertResult="true" />
    </Or>
  </OrRule>
</EnableRule>`;
        const condition = parseRuleCondition(xml);
        assert.strictEqual(condition.type, 'OrRule');
        if (condition.type === 'OrRule') {
            assert.deepStrictEqual(condition.conditions, [
                { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: false, otherAttrs: {} },
                { type: 'FormStateRule', state: 'Create', invertResult: true, otherAttrs: {} },
            ]);
        }
    });

    it('parses an OrRule with multiple <Or> siblings of the same nested condition type', () => {
        const xml = `<DisplayRule Id="r1">
  <OrRule>
    <Or>
      <EntityRule EntityName="account" />
    </Or>
    <Or>
      <EntityRule EntityName="contact" />
    </Or>
  </OrRule>
</DisplayRule>`;
        const condition = parseRuleCondition(xml);
        assert.strictEqual(condition.type, 'OrRule');
        if (condition.type === 'OrRule') {
            assert.strictEqual(condition.conditions.length, 2);
            assert.deepStrictEqual(condition.conditions.map(c => (c.type === 'EntityRule' ? c.entityName : undefined)), ['account', 'contact']);
        }
    });

    it('falls back to Raw when a nested condition is unrecognized (bails the whole OrRule, not just that clause)', () => {
        const xml = '<EnableRule Id="r1"><OrRule><Or><CrmClientTypeRule Type="Web" /></Or><Or><FeatureControlRule /></Or></OrRule></EnableRule>';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });

    it('falls back to Raw for a single <Or> wrapping more than one condition (an AND-group nested inside one OR clause -- not representable in this editor\'s flat per-clause model)', () => {
        const xml = '<EnableRule Id="r1"><OrRule><Or><CrmClientTypeRule Type="Web" /><FormStateRule State="Create" /></Or><Or><SkuRule Sku="Online" /></Or></OrRule></EnableRule>';
        assert.deepStrictEqual(parseRuleCondition(xml), { type: 'Raw', xml });
    });

    it('falls back to Raw for an OrRule with no Or child, or an Or with no conditions', () => {
        assert.deepStrictEqual(
            parseRuleCondition('<EnableRule Id="r1"><OrRule /></EnableRule>'),
            { type: 'Raw', xml: '<EnableRule Id="r1"><OrRule /></EnableRule>' },
        );
        assert.deepStrictEqual(
            parseRuleCondition('<EnableRule Id="r1"><OrRule><Or /></OrRule></EnableRule>'),
            { type: 'Raw', xml: '<EnableRule Id="r1"><OrRule><Or /></OrRule></EnableRule>' },
        );
    });
});

describe('serializeRuleCondition', () => {
    it('round-trips every non-Raw structured type', () => {
        for (const type of RULE_CONDITION_TYPES) {
            if (type === 'Raw') { continue; }
            const original = defaultRuleCondition(type);
            const xml = serializeRuleCondition('r1', 'EnableRule', original);
            const reparsed = parseRuleCondition(xml);
            assert.deepStrictEqual(reparsed, original, `round-trip mismatch for ${type}:\n${xml}`);
        }
    });

    it('emits InvertResult only when true', () => {
        const withInvert = serializeRuleCondition('r1', 'EnableRule', { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: true, otherAttrs: {} });
        assert.match(withInvert, /InvertResult="true"/);

        const withoutInvert = serializeRuleCondition('r1', 'EnableRule', { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: false, otherAttrs: {} });
        assert.doesNotMatch(withoutInvert, /InvertResult/);
    });

    it('preserves otherAttrs on serialize', () => {
        const xml = serializeRuleCondition('r1', 'EnableRule', { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: false, otherAttrs: { Default: 'true' } });
        assert.match(xml, /Default="true"/);
    });

    it('serializes CustomRule parameters as CrmParameter elements', () => {
        const xml = serializeRuleCondition('r1', 'EnableRule', {
            type: 'CustomRule', library: '$webresource:lib.js', functionName: 'run', params: ['a', 'b'], invertResult: false, otherAttrs: {},
        });
        assert.match(xml, /<CrmParameter Value="a"\/?>/);
        assert.match(xml, /<CrmParameter Value="b"\/?>/);
    });

    it('always emits AppliesTo="SelectedEntity" for RelationshipTypeRule (the only documented/required value)', () => {
        const xml = serializeRuleCondition('r1', 'DisplayRule', defaultRuleCondition('RelationshipTypeRule'));
        assert.match(xml, /AppliesTo="SelectedEntity"/);
    });

    it('uses the DisplayRule wrapper tag when asked', () => {
        const xml = serializeRuleCondition('r1', 'DisplayRule', defaultRuleCondition('FormStateRule'));
        assert.match(xml, /^<DisplayRule Id="r1">/);
    });

    it('returns Raw xml verbatim', () => {
        const raw: RibbonRuleCondition = { type: 'Raw', xml: '<EnableRule Id="r1"><Whatever /></EnableRule>' };
        assert.strictEqual(serializeRuleCondition('r1', 'EnableRule', raw), raw.xml);
    });

    it('serializes an OrRule with multiple different condition types, each in its own <Or> sibling', () => {
        const xml = serializeRuleCondition('r1', 'EnableRule', {
            type: 'OrRule',
            conditions: [
                { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: false, otherAttrs: {} },
                { type: 'FormStateRule', state: 'Create', invertResult: false, otherAttrs: {} },
            ],
        });
        assert.match(
            xml,
            /<OrRule>\s*<Or>\s*<CrmClientTypeRule Type="Web"\/?>\s*<\/Or>\s*<Or>\s*<FormStateRule State="Create"\/?>\s*<\/Or>\s*<\/OrRule>/,
        );
    });

    it('serializes an OrRule with multiple siblings of the same condition type as separate <Or> elements, not grouped under one', () => {
        const xml = serializeRuleCondition('r1', 'DisplayRule', {
            type: 'OrRule',
            conditions: [
                { type: 'EntityRule', entityName: 'account', context: '', appliesTo: '', invertResult: false, otherAttrs: {} },
                { type: 'EntityRule', entityName: 'contact', context: '', appliesTo: '', invertResult: false, otherAttrs: {} },
            ],
        });
        const orBlocks = [...xml.matchAll(/<Or>([\s\S]*?)<\/Or>/g)].map(m => m[1].trim());
        assert.strictEqual(orBlocks.length, 2, 'each clause must be its own <Or>, not two conditions inside one');
        assert.match(orBlocks[0], /^<EntityRule EntityName="account"\/?>$/);
        assert.match(orBlocks[1], /^<EntityRule EntityName="contact"\/?>$/);
    });

    it('never puts more than one condition inside a single <Or> -- that evaluates as an AND, not an OR, and is the root cause of two real bugs this editor hit', () => {
        const xml = serializeRuleCondition('r1', 'EnableRule', {
            type: 'OrRule',
            conditions: [
                { type: 'CrmClientTypeRule', clientType: 'Web', invertResult: false, otherAttrs: {} },
                { type: 'CrmClientTypeRule', clientType: 'Outlook', invertResult: false, otherAttrs: {} },
            ],
        });
        const orOpenTags = xml.match(/<Or>/g) ?? [];
        assert.strictEqual(orOpenTags.length, 2, 'two clauses must produce two <Or> elements');
    });

    it('does not round-trip a leaf condition\'s Id as an otherAttrs entry -- not schema data this editor models per leaf condition', () => {
        const xml = '<EnableRule Id="r1"><OrRule><Or><CrmClientTypeRule Type="Web" Id="some.stale.id" /></Or></OrRule></EnableRule>';
        const condition = parseRuleCondition(xml);
        assert.strictEqual(condition.type, 'OrRule');
        if (condition.type === 'OrRule') {
            assert.deepStrictEqual(condition.conditions[0].otherAttrs, {});
        }
    });
});

describe('ruleConditionLabel / defaultRuleCondition', () => {
    it('gives every declared type a non-empty label and a matching default condition', () => {
        for (const type of RULE_CONDITION_TYPES) {
            const condition = defaultRuleCondition(type);
            assert.strictEqual(condition.type, type);
            assert.ok(ruleConditionLabel(condition).length > 0);
        }
    });
});

describe('ruleTypesFor / ENABLE_RULE_TYPES / DISPLAY_RULE_TYPES', () => {
    it('restricts enable-only condition types (schema: parent element is EnableRule/Or only) to the Enable bucket', () => {
        for (const type of ['CustomRule', 'OutlookItemTrackingRule', 'RecordPrivilegeRule', 'SelectionCountRule'] as const) {
            assert.ok(ENABLE_RULE_TYPES.includes(type), `expected ${type} in ENABLE_RULE_TYPES`);
            assert.ok(!DISPLAY_RULE_TYPES.includes(type), `expected ${type} NOT in DISPLAY_RULE_TYPES`);
        }
    });

    it('restricts display-only condition types (schema: parent element is DisplayRule/Or only) to the Display bucket', () => {
        for (const type of [
            'EntityPrivilegeRule', 'EntityPropertyRule', 'FormEntityContextRule', 'FormTypeRule',
            'HideForTabletExperienceRule', 'MiscellaneousPrivilegeRule', 'OrganizationSettingRule',
            'OutlookRenderTypeRule', 'ReferencingAttributeRequiredRule', 'RelationshipTypeRule',
        ] as const) {
            assert.ok(DISPLAY_RULE_TYPES.includes(type), `expected ${type} in DISPLAY_RULE_TYPES`);
            assert.ok(!ENABLE_RULE_TYPES.includes(type), `expected ${type} NOT in ENABLE_RULE_TYPES`);
        }
    });

    it('allows condition types valid for both wrappers in both buckets', () => {
        for (const type of [
            'CommandClientTypeRule', 'CrmClientTypeRule', 'CrmOfflineAccessStateRule', 'CrmOutlookClientTypeRule',
            'EntityRule', 'FormStateRule', 'OutlookVersionRule', 'PageRule', 'SkuRule', 'ValueRule',
        ] as const) {
            assert.ok(ENABLE_RULE_TYPES.includes(type), `expected ${type} in ENABLE_RULE_TYPES`);
            assert.ok(DISPLAY_RULE_TYPES.includes(type), `expected ${type} in DISPLAY_RULE_TYPES`);
        }
    });

    it('ruleTypesFor returns the matching bucket for each wrapper tag', () => {
        assert.deepStrictEqual(ruleTypesFor('EnableRule'), ENABLE_RULE_TYPES);
        assert.deepStrictEqual(ruleTypesFor('DisplayRule'), DISPLAY_RULE_TYPES);
    });

    it('OrRule is valid at the top level of both wrappers, matching the schema (parent: DisplayRule, EnableRule)', () => {
        assert.ok(ENABLE_RULE_TYPES.includes('OrRule'));
        assert.ok(DISPLAY_RULE_TYPES.includes('OrRule'));
    });

    it('every declared condition type is assigned to at least one bucket', () => {
        for (const type of RULE_CONDITION_TYPES) {
            assert.ok(ENABLE_RULE_TYPES.includes(type) || DISPLAY_RULE_TYPES.includes(type), `${type} isn't in either bucket`);
        }
    });
});

describe('leafRuleTypesFor', () => {
    it('excludes OrRule and Raw (an Or nests leaf conditions only, not another Or or raw XML)', () => {
        for (const wrapperTag of ['EnableRule', 'DisplayRule'] as const) {
            const types = leafRuleTypesFor(wrapperTag);
            assert.ok(!types.includes('OrRule' as never));
            assert.ok(!types.includes('Raw' as never));
        }
    });

    it('matches the same enable/display restriction as ruleTypesFor for leaf types', () => {
        for (const type of leafRuleTypesFor('EnableRule')) { assert.ok(ENABLE_RULE_TYPES.includes(type)); }
        for (const type of leafRuleTypesFor('DisplayRule')) { assert.ok(DISPLAY_RULE_TYPES.includes(type)); }
    });

    it('defaultLeafCondition produces a valid default for every leaf type', () => {
        for (const wrapperTag of ['EnableRule', 'DisplayRule'] as const) {
            for (const type of leafRuleTypesFor(wrapperTag)) {
                const leaf = defaultLeafCondition(type);
                assert.strictEqual(leaf.type, type);
            }
        }
    });
});
