import * as assert from 'assert';
import { buildRibbonDiffXml, mergeRibbonDiffXml } from '../../src/ribbon/ribbonXmlBuilder';
import type { RibbonModel } from '../../src/ribbon/ribbonModel';

function baseModel(): RibbonModel {
    return {
        tabs: [
            {
                id: 'Mscrm.form.account.MainTab',
                title: 'Home',
                status: 'unchanged',
                groups: [
                    {
                        id: 'grp.currency',
                        title: 'My Group',
                        status: 'unchanged',
                        controls: [
                            { kind: 'Button', id: 'added_button', label: 'Added', toolTipTitle: '', toolTipDescription: '', status: 'added' },
                            { kind: 'Button', id: 'existing_button', label: 'Edited Label', toolTipTitle: '', toolTipDescription: '', status: 'modified' },
                            { kind: 'Button', id: 'removed_button', label: 'Gone', toolTipTitle: '', toolTipDescription: '', status: 'deleted' },
                        ],
                    },
                ],
            },
            {
                id: 'new_tab',
                title: 'New Tab',
                status: 'added',
                groups: [
                    {
                        id: 'new_group',
                        title: 'New Group',
                        status: 'added',
                        controls: [
                            { kind: 'Button', id: 'new_tab_button', label: 'In New Tab', toolTipTitle: '', toolTipDescription: '', status: 'added' },
                        ],
                    },
                ],
            },
        ],
        commandDefinitions: [
            { id: 'cmd.unchanged', enableRules: [], displayRules: [], actions: [], status: 'unchanged' },
            { id: 'cmd.added', enableRules: ['rule.enable1'], displayRules: [], actions: [{ type: 'JavaScriptFunction', library: '$webresource:lib.js', functionName: 'run', params: [{ type: 'StringParameter', value: 'a' }] }], status: 'added' },
        ],
        enableRules: [
            { id: 'rule.enable1', xml: '<EnableRule Id="rule.enable1">\n  <CrmClientTypeRule Type="Web" />\n</EnableRule>', status: 'added' },
        ],
        displayRules: [
            { id: 'rule.display1', xml: '<DisplayRule Id="rule.display1">\n  <CustomRule Library="$webresource:lib.js" FunctionName="isVisible" />\n</DisplayRule>', status: 'modified' },
        ],
        locLabels: {},
    };
}

describe('buildRibbonDiffXml', () => {
    it('emits a CustomAction for an added control anchored at its group', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<CustomAction Id="added_button\.Custom" Location="grp\.currency\.Controls\._children" Sequence="\d+">/);
        assert.match(xml, /<Button Id="added_button"[^/]*LabelText="Added"/);
    });

    it('wraps a CustomAction\'s ribbon markup in CommandUIDefinition -- Dataverse rejects import without it', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(
            xml,
            /<CustomAction Id="added_button\.Custom"[^>]*>\s*<CommandUIDefinition>\s*<Button Id="added_button"[\s\S]*?<\/CommandUIDefinition>\s*<\/CustomAction>/,
        );
    });

    it('gives a directly-added-to-group control a TemplateAlias and a Sequence matching its CustomAction, or Dataverse imports it but never renders it', () => {
        const xml = buildRibbonDiffXml(baseModel());
        const customActionMatch = /<CustomAction Id="added_button\.Custom"[^>]*Sequence="(\d+)"/.exec(xml);
        assert.ok(customActionMatch, 'expected to find the CustomAction and its Sequence');
        const buttonMatch = /<Button Id="added_button"[^/]*\/>/.exec(xml);
        assert.ok(buttonMatch, 'expected to find the added_button element');
        assert.match(buttonMatch![0], /TemplateAlias="o2"/);
        assert.match(buttonMatch![0], new RegExp(`Sequence="${customActionMatch![1]}"`));
    });

    it('emits a HideCustomAction plus a replacement CustomAction for a modified control', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<HideCustomAction Id="existing_button\.Hide" Location="grp\.currency\.Controls\._children" CommandUIElementId="existing_button" \/>/);
        assert.match(xml, /<CustomAction Id="existing_button\.Custom" Location="grp\.currency\.Controls\._children"[^>]*>[\s\S]*?LabelText="Edited Label"/);
    });

    it('emits only a HideCustomAction for a deleted control (no replacement)', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<HideCustomAction Id="removed_button\.Hide" Location="grp\.currency\.Controls\._children" CommandUIElementId="removed_button" \/>/);
        assert.doesNotMatch(xml, /Id="removed_button\.Custom"/);
    });

    it('emits a brand-new tab as a single CustomAction anchored at Mscrm.Tabs._children, nesting its groups/controls', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<CustomAction Id="new_tab\.Custom" Location="Mscrm\.Tabs\._children"/);
        assert.match(xml, /<Tab Id="new_tab" Title="New Tab">[\s\S]*<Group Id="new_group"[\s\S]*<Button Id="new_tab_button"/);
        // The new tab's own group/control must not also appear as separate top-level CustomActions.
        assert.doesNotMatch(xml, /Id="new_group\.Custom"/);
        assert.doesNotMatch(xml, /Id="new_tab_button\.Custom"/);
    });

    it('includes added/modified command definitions but omits unchanged ones', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<CommandDefinition Id="cmd\.added">/);
        assert.doesNotMatch(xml, /Id="cmd\.unchanged"/);
    });

    it('always emits EnableRules/DisplayRules on a CommandDefinition, even empty, matching a real Dataverse export', () => {
        // cmd.added has enableRules but no displayRules -- exercises both the non-empty and empty case.
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<CommandDefinition Id="cmd\.added">\s*<EnableRules>\s*<EnableRule Id="rule\.enable1"\s*\/>\s*<\/EnableRules>\s*<DisplayRules\s*\/>/);
    });

    it('serializes each JavaScriptFunction parameter under its own type tag, not always CrmParameter', () => {
        const model = baseModel();
        model.commandDefinitions[1].actions = [{
            type: 'JavaScriptFunction',
            library: '$webresource:lib.js',
            functionName: 'run',
            params: [
                { type: 'StringParameter', value: 'hello' },
                { type: 'CrmParameter', value: 'PrimaryControl' },
                { type: 'BoolParameter', value: true },
                { type: 'DecimalParameter', value: '1.5' },
                { type: 'IntParameter', value: '3' },
            ],
        }];
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<StringParameter Value="hello"\s*\/>/);
        assert.match(xml, /<CrmParameter Value="PrimaryControl"\s*\/>/);
        assert.match(xml, /<BoolParameter Value="true"\s*\/>/);
        assert.match(xml, /<DecimalParameter Value="1\.5"\s*\/>/);
        assert.match(xml, /<IntParameter Value="3"\s*\/>/);
    });

    it('includes added/modified rule fragments under RuleDefinitions', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<EnableRules>[\s\S]*CrmClientTypeRule[\s\S]*<\/EnableRules>/);
        assert.match(xml, /<DisplayRules>[\s\S]*CustomRule[\s\S]*<\/DisplayRules>/);
    });

    it('preserves a control\'s modernImage attribute', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[0].modernImage = 'Refresh';
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<Button Id="added_button"[^/]*ModernImage="Refresh"/);
    });

    it('produces a well-formed top-level RibbonDiffXml document', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.ok(xml.startsWith('<RibbonDiffXml>'));
        assert.ok(xml.trim().endsWith('</RibbonDiffXml>'));
        assert.match(xml, /<CustomActions>[\s\S]*<\/CustomActions>/);
        assert.match(xml, /<CommandDefinitions>[\s\S]*<\/CommandDefinitions>/);
        assert.match(xml, /<HideCustomActions>[\s\S]*<\/HideCustomActions>/);
    });
});

describe('mergeRibbonDiffXml', () => {
    const existingDiff = `<RibbonDiffXml>
  <CustomActions>
    <CustomAction Id="prior_button.Custom" Location="grp.other.Controls._children" Sequence="50">
      <CommandUIDefinition>
        <Button Id="prior_button" LabelText="Prior" Sequence="50" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="existing_button.Custom" Location="grp.currency.Controls._children" Sequence="60">
      <CommandUIDefinition>
        <Button Id="existing_button" LabelText="Old Label" Sequence="60" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="removed_button.Custom" Location="grp.currency.Controls._children" Sequence="70">
      <CommandUIDefinition>
        <Button Id="removed_button" LabelText="Gone" Sequence="70" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
  </CustomActions>
  <Templates />
  <CommandDefinitions>
    <CommandDefinition Id="cmd.prior">
      <EnableRules />
      <DisplayRules />
    </CommandDefinition>
  </CommandDefinitions>
  <RuleDefinitions>
    <TabDisplayRules />
    <DisplayRules>
      <DisplayRule Id="rule.priorDisplay">
        <CustomRule Library="$webresource:old.js" FunctionName="oldFn" />
      </DisplayRule>
    </DisplayRules>
    <EnableRules>
      <EnableRule Id="rule.priorEnable">
        <CrmClientTypeRule Type="Web" />
      </EnableRule>
    </EnableRules>
  </RuleDefinitions>
  <HideCustomActions>
    <HideCustomAction Id="already_hidden.Hide" Location="grp.currency.Controls._children" CommandUIElementId="already_hidden" />
  </HideCustomActions>
</RibbonDiffXml>`;

    it('is equivalent to buildRibbonDiffXml when there is no existing diff to merge into', () => {
        const model = baseModel();
        assert.strictEqual(mergeRibbonDiffXml('', model), buildRibbonDiffXml(model));
    });

    it('preserves an existing customization this session never touched', () => {
        const xml = mergeRibbonDiffXml(existingDiff, baseModel());
        assert.match(xml, /<CustomAction Id="prior_button\.Custom"[\s\S]*?LabelText="Prior"[\s\S]*?<\/CustomAction>/);
        assert.match(xml, /<CommandDefinition Id="cmd\.prior">/);
        assert.match(xml, /<DisplayRule Id="rule\.priorDisplay">/);
        assert.match(xml, /<EnableRule Id="rule\.priorEnable">/);
        assert.match(xml, /<HideCustomAction Id="already_hidden\.Hide"/);
    });

    it('replaces an existing CustomAction sharing an Id with this session\'s edit, instead of duplicating it', () => {
        const xml = mergeRibbonDiffXml(existingDiff, baseModel());
        const matches = xml.match(/Id="existing_button\.Custom"/g);
        assert.strictEqual(matches?.length, 1, 'the old and new existing_button.Custom fragments must not both appear');
        assert.doesNotMatch(xml, /Old Label/);
        assert.match(xml, /LabelText="Edited Label"/);
    });

    it('still emits this session\'s new fragments (added tab/control) alongside preserved ones', () => {
        const xml = mergeRibbonDiffXml(existingDiff, baseModel());
        assert.match(xml, /<CustomAction Id="added_button\.Custom"/);
        assert.match(xml, /<CustomAction Id="new_tab\.Custom"/);
        assert.match(xml, /<CommandDefinition Id="cmd\.added">/);
    });

    it('does not carry through an existing fragment with no Id attribute at all as a duplicate-safety edge case', () => {
        // A HideCustomAction with the same target Id as this session's own delete should not duplicate.
        const model = baseModel();
        const xml = mergeRibbonDiffXml(existingDiff, model);
        const hideMatches = xml.match(/Id="removed_button\.Hide"/g);
        assert.strictEqual(hideMatches?.length, 1);
    });

    it('removes a previously-customized control\'s own CustomAction outright when deleted this session, not just a Hide alongside it', () => {
        // existingDiff's removed_button.Custom represents a prior customization; baseModel marks
        // removed_button 'deleted' this session -- it should be truly gone, not left as dead weight.
        const xml = mergeRibbonDiffXml(existingDiff, baseModel());
        assert.doesNotMatch(xml, /Id="removed_button\.Custom"/);
        assert.match(xml, /<HideCustomAction Id="removed_button\.Hide"/);
    });

    it('still just Hides a deleted control with no prior CustomAction to remove (e.g. genuine base ribbon), without erroring', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'base_button', label: 'Base', toolTipTitle: '', toolTipDescription: '', status: 'deleted' },
        );
        const xml = mergeRibbonDiffXml(existingDiff, model);
        assert.match(xml, /<HideCustomAction Id="base_button\.Hide"/);
        assert.doesNotMatch(xml, /Id="base_button\.Custom"/);
    });
});
