import * as assert from 'assert';
import { buildRibbonDiffFragments, buildRibbonDiffXml, findDuplicateCustomActionTargets, findInvalidFlyoutAnchors, mergeRibbonDiffXml, resolveLabelsFromCache } from '../../src/ribbon/ribbonXmlBuilder';
import type { RibbonControl, RibbonModel } from '../../src/ribbon/ribbonModel';

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
                            { kind: 'Button', id: 'existing_button', label: 'Edited Label', toolTipTitle: '', toolTipDescription: '', status: 'modified', sequence: '40' },
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
        assert.match(xml, /<Button Id="added_button"[^/]*LabelText="\$LocLabels:added_button\.LabelText"/);
    });

    it('emits literal label/tooltip text as a $LocLabels reference plus a matching LocLabel definition, not raw text', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<Button Id="added_button"[^/]*LabelText="\$LocLabels:added_button\.LabelText"/);
        assert.match(
            xml,
            /<LocLabels>[\s\S]*<LocLabel Id="added_button\.LabelText">\s*<Titles>\s*<Title languagecode="1033" description="Added"\s*\/>\s*<\/Titles>\s*<\/LocLabel>[\s\S]*<\/LocLabels>/,
        );
    });

    it('passes an already-unresolved $LocLabels/$Resources reference straight through, without re-wrapping it', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[0].label = '$LocLabels:some.other.key';
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<Button Id="added_button"[^/]*LabelText="\$LocLabels:some\.other\.key"/);
        assert.doesNotMatch(xml, /LocLabel Id="added_button\.LabelText"/);
    });

    it('returns resolvedLabels as a plain LocLabel-Id -> literal-text map alongside the XML fragments -- see ribbonEditorPanel.ts\'s resolvedLabelCache', () => {
        const fragments = buildRibbonDiffFragments(baseModel());
        assert.strictEqual(fragments.resolvedLabels['added_button.LabelText'], 'Added');
        assert.strictEqual(fragments.resolvedLabels['existing_button.LabelText'], 'Edited Label');
        assert.strictEqual(fragments.resolvedLabels['new_tab.Title'], 'New Tab');
    });

    it('does not add a resolvedLabels entry for a control whose label is already an unresolved reference -- nothing to remember', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[0].label = '$LocLabels:some.other.key';
        const fragments = buildRibbonDiffFragments(model);
        assert.strictEqual(fragments.resolvedLabels['added_button.LabelText'], undefined);
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
        assert.match(xml, /<CustomAction Id="existing_button\.Custom" Location="grp\.currency\.Controls\._children"[^>]*>[\s\S]*?LabelText="\$LocLabels:existing_button\.LabelText"/);
    });

    it('reuses a modified control\'s original Sequence, so editing a field (e.g. its label) doesn\'t reorder it among its siblings', () => {
        // existing_button carries sequence: '40' in baseModel() -- a bare edit must not overwrite it
        // with a fresh counter value (that would move it to wherever the counter happens to land,
        // typically past every untouched sibling's much lower original Sequence).
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<CustomAction Id="existing_button\.Custom" Location="grp\.currency\.Controls\._children" Sequence="40">/);
        assert.match(xml, /<Button Id="existing_button"[^/]*Sequence="40"/);
    });

    it('assigns a fresh counter-based Sequence to a control with no known original position (added this session)', () => {
        const xml = buildRibbonDiffXml(baseModel());
        const customActionMatch = /<CustomAction Id="added_button\.Custom"[^>]*Sequence="(\d+)"/.exec(xml);
        assert.ok(customActionMatch);
        assert.notStrictEqual(customActionMatch![1], '40', 'should not collide with existing_button\'s preserved Sequence');
    });

    it('preserves an unmodified sibling control\'s Sequence when its enclosing group is wholesale re-serialized (e.g. the group\'s own title was edited)', () => {
        const model = baseModel();
        model.tabs[0].groups[0].status = 'modified';
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'untouched_sibling', label: 'Untouched', toolTipTitle: '', toolTipDescription: '', status: 'unchanged', sequence: '30' },
        );
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<Button Id="untouched_sibling"[^/]*Sequence="30"/);
    });

    it('emits only a HideCustomAction for a deleted control (no replacement)', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<HideCustomAction Id="removed_button\.Hide" Location="grp\.currency\.Controls\._children" CommandUIElementId="removed_button" \/>/);
        assert.doesNotMatch(xml, /Id="removed_button\.Custom"/);
    });

    it("emits NEITHER a HideCustomAction NOR a replacement CustomAction for a 'reverted' control -- the whole point is to let the base definition show through untouched", () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'reverted_button', label: 'Reverted', toolTipTitle: '', toolTipDescription: '', status: 'reverted' },
        );
        const fragments = buildRibbonDiffFragments(model);
        assert.deepStrictEqual(fragments.touchedElementIds.includes('reverted_button'), true, 'must still be reported so an existing competing CustomAction gets stripped on merge');
        assert.doesNotMatch(buildRibbonDiffXml(model), /reverted_button\.Hide/);
        assert.doesNotMatch(buildRibbonDiffXml(model), /Id="reverted_button\.Custom"/);
    });

    it("omits a 'reverted' control from a wholesale group re-serialize too, so it isn't redeclared as part of an unrelated sibling edit", () => {
        const model = baseModel();
        model.tabs[0].groups[0].status = 'modified';
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'reverted_button', label: 'Reverted', toolTipTitle: '', toolTipDescription: '', status: 'reverted' },
        );
        const xml = buildRibbonDiffXml(model);
        assert.doesNotMatch(xml, /Id="reverted_button"/);
    });

    it('emits a brand-new tab as a single CustomAction anchored at Mscrm.Tabs._children, nesting its groups/controls', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<CustomAction Id="new_tab\.Custom" Location="Mscrm\.Tabs\._children"/);
        assert.match(xml, /<Tab Id="new_tab"[^>]*Title="\$LocLabels:new_tab\.Title">[\s\S]*<Group Id="new_group"[\s\S]*<Button Id="new_tab_button"/);
        // The new tab's own group/control must not also appear as separate top-level CustomActions.
        assert.doesNotMatch(xml, /Id="new_group\.Custom"/);
        assert.doesNotMatch(xml, /Id="new_tab_button\.Custom"/);
    });

    it('gives a brand-new group a Template/Command, or every button added to it stays invisible regardless of anything else about it being correct', () => {
        const xml = buildRibbonDiffXml(baseModel());
        const groupMatch = /<Group Id="new_group"[^>]*\/?>/.exec(xml) ?? /<Group Id="new_group"[^>]*>/.exec(xml);
        assert.ok(groupMatch, 'expected to find the new_group element');
        assert.match(groupMatch![0], /Template="Mscrm\.Templates\.Flexible2"/);
        assert.match(groupMatch![0], /Command="Mscrm\.Enabled"/);
    });

    it('preserves an existing (parsed) group\'s own Template/Command when it\'s re-serialized on edit, rather than overwriting it with the new-group default', () => {
        const model = baseModel();
        model.tabs[0].groups[0].status = 'modified';
        model.tabs[0].groups[0].template = 'Mscrm.Templates.Flexible';
        model.tabs[0].groups[0].command = 'Mscrm.SomeOtherGroupCommand';
        const xml = buildRibbonDiffXml(model);
        const groupMatch = /<Group Id="grp\.currency"[^>]*>/.exec(xml);
        assert.ok(groupMatch, 'expected to find the grp.currency element');
        assert.match(groupMatch![0], /Template="Mscrm\.Templates\.Flexible"/);
        assert.match(groupMatch![0], /Command="Mscrm\.SomeOtherGroupCommand"/);
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

    it('preserves a built-in Fluent icon name on modernImage as-is, without a $webresource: prefix', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[0].modernImage = 'Refresh';
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<Button Id="added_button"[^/]*ModernImage="Refresh"/);
    });

    it('prefixes a plain web resource name on image16/image32/modernImage/JS Library with $webresource:, since Dataverse only resolves the prefixed form', () => {
        const model = baseModel();
        const control = model.tabs[0].groups[0].controls[0];
        control.image16 = 'new_icon16.png';
        control.image32 = 'new_icon32.png';
        control.modernImage = 'new_custom_icon.png'; // not a built-in Fluent icon name
        model.commandDefinitions[1].actions = [{ type: 'JavaScriptFunction', library: 'new_lib.js', functionName: 'run', params: [] }];
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<Button Id="added_button"[^/]*Image16by16="\$webresource:new_icon16\.png"/);
        assert.match(xml, /<Button Id="added_button"[^/]*Image32by32="\$webresource:new_icon32\.png"/);
        assert.match(xml, /<Button Id="added_button"[^/]*ModernImage="\$webresource:new_custom_icon\.png"/);
        assert.match(xml, /<JavaScriptFunction Library="\$webresource:new_lib\.js"/);
    });

    it('leaves an already-prefixed $webresource: reference or a /-rooted system path untouched', () => {
        const model = baseModel();
        const control = model.tabs[0].groups[0].controls[0];
        control.image16 = '$webresource:new_icon16.png';
        control.image32 = '/_imgs/ribbon/edit.png';
        const xml = buildRibbonDiffXml(model);
        assert.match(xml, /<Button Id="added_button"[^/]*Image16by16="\$webresource:new_icon16\.png"/);
        assert.match(xml, /<Button Id="added_button"[^/]*Image32by32="\/_imgs\/ribbon\/edit\.png"/);
    });

    it('produces a well-formed top-level RibbonDiffXml document', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.ok(xml.startsWith('<RibbonDiffXml>'));
        assert.ok(xml.trim().endsWith('</RibbonDiffXml>'));
        assert.match(xml, /<CustomActions>[\s\S]*<\/CustomActions>/);
        assert.match(xml, /<CommandDefinitions>[\s\S]*<\/CommandDefinitions>/);
        assert.match(xml, /<LocLabels>[\s\S]*<\/LocLabels>/);
        assert.match(xml, /<HideCustomActions>[\s\S]*<\/HideCustomActions>/);
    });
});

describe('resolveLabelsFromCache', () => {
    it("fills in a control's label from the cache when it's still an unresolved $LocLabels reference", () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[1].label = '$LocLabels:existing_button.LabelText';
        resolveLabelsFromCache(model, { 'existing_button.LabelText': 'Edited Label' });
        assert.strictEqual(model.tabs[0].groups[0].controls[1].label, 'Edited Label');
    });

    it('fills in a tab/group title the same way', () => {
        const model = baseModel();
        model.tabs[0].title = '$LocLabels:Mscrm.form.account.MainTab.Title';
        model.tabs[0].groups[0].title = '$LocLabels:grp.currency.Title';
        resolveLabelsFromCache(model, {
            'Mscrm.form.account.MainTab.Title': 'Home',
            'grp.currency.Title': 'My Group',
        });
        assert.strictEqual(model.tabs[0].title, 'Home');
        assert.strictEqual(model.tabs[0].groups[0].title, 'My Group');
    });

    it('leaves a reference as-is on a cache miss, instead of guessing wrong', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[1].label = '$LocLabels:existing_button.LabelText';
        resolveLabelsFromCache(model, {});
        assert.strictEqual(model.tabs[0].groups[0].controls[1].label, '$LocLabels:existing_button.LabelText');
    });

    it('does not touch a value that already resolved to something else (e.g. base-ribbon $Resources: text)', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[1].label = 'Some Other Text';
        resolveLabelsFromCache(model, { 'existing_button.LabelText': 'Wrong Value' });
        assert.strictEqual(model.tabs[0].groups[0].controls[1].label, 'Some Other Text');
    });

    it("resolves a nested FlyoutAnchor/MenuSection child's label too", () => {
        const model = baseModel();
        const flyout: RibbonControl = {
            kind: 'FlyoutAnchor', id: 'flyout1', label: '', toolTipTitle: '', toolTipDescription: '', status: 'unchanged',
            controls: [{
                kind: 'MenuSection', id: 'flyout1.section1', label: '', toolTipTitle: '', toolTipDescription: '', status: 'unchanged',
                controls: [{
                    kind: 'Button', id: 'flyout1.child', label: '$LocLabels:flyout1.child.LabelText', toolTipTitle: '', toolTipDescription: '', status: 'unchanged',
                }],
            }],
        };
        model.tabs[0].groups[0].controls.push(flyout);
        resolveLabelsFromCache(model, { 'flyout1.child.LabelText': 'Nested Item' });
        assert.strictEqual((flyout.controls![0].controls![0] as RibbonControl).label, 'Nested Item');
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
        assert.match(xml, /LabelText="\$LocLabels:existing_button\.LabelText"/);
        assert.match(xml, /<LocLabel Id="existing_button\.LabelText">\s*<Titles>\s*<Title languagecode="1033" description="Edited Label"\s*\/>/);
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

    it('strips an existing CustomAction redeclaring the same element even when another tool named its wrapper differently -- confirmed against a live org where a Ribbon-Workbench-created "{prefix}.{ElementId}.CustomAction" wrapper kept re-declaring a button this session hides, defeating the Hide', () => {
        const diffFromAnotherTool = `<RibbonDiffXml>
  <CustomActions>
    <CustomAction Id="tn.Mscrm.SubGrid.contact.NewRecord.CustomAction" Location="grp.currency.Controls._children" Sequence="30">
      <CommandUIDefinition>
        <Button Id="Mscrm.SubGrid.contact.NewRecord" Command="Mscrm.NewRecordFromGrid" LabelText="New" Sequence="30" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
  </CustomActions>
  <Templates />
  <CommandDefinitions></CommandDefinitions>
  <RuleDefinitions>
    <TabDisplayRules />
    <DisplayRules></DisplayRules>
    <EnableRules></EnableRules>
  </RuleDefinitions>
  <HideCustomActions></HideCustomActions>
</RibbonDiffXml>`;
        const model = baseModel();
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'Mscrm.SubGrid.contact.NewRecord', label: 'New', toolTipTitle: '', toolTipDescription: '', status: 'deleted' },
        );
        const xml = mergeRibbonDiffXml(diffFromAnotherTool, model);
        assert.doesNotMatch(xml, /tn\.Mscrm\.SubGrid\.contact\.NewRecord\.CustomAction/, 'the other tool\'s wrapper must be stripped, not left redeclaring the hidden element');
        assert.match(xml, /<HideCustomAction Id="Mscrm\.SubGrid\.contact\.NewRecord\.Hide" .*CommandUIElementId="Mscrm\.SubGrid\.contact\.NewRecord"/);
    });

    it('leaves an existing CustomAction from another tool alone when it declares a DIFFERENT element than anything touched this session', () => {
        const diffFromAnotherTool = `<RibbonDiffXml>
  <CustomActions>
    <CustomAction Id="tn.Mscrm.SubGrid.contact.Edit.CustomAction" Location="grp.currency.Controls._children" Sequence="80">
      <CommandUIDefinition>
        <Button Id="Mscrm.SubGrid.contact.Edit" Command="Mscrm.EditSelectedRecord" LabelText="Edit" Sequence="80" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
  </CustomActions>
  <Templates />
  <CommandDefinitions></CommandDefinitions>
  <RuleDefinitions>
    <TabDisplayRules />
    <DisplayRules></DisplayRules>
    <EnableRules></EnableRules>
  </RuleDefinitions>
  <HideCustomActions></HideCustomActions>
</RibbonDiffXml>`;
        const model = baseModel();
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'Mscrm.SubGrid.contact.NewRecord', label: 'New', toolTipTitle: '', toolTipDescription: '', status: 'deleted' },
        );
        const xml = mergeRibbonDiffXml(diffFromAnotherTool, model);
        assert.match(xml, /tn\.Mscrm\.SubGrid\.contact\.Edit\.CustomAction/, 'unrelated existing customization must be left alone');
    });

    it("'reverted' strips a competing customization from another tool WITHOUT hiding the element -- the actual fix for Ribbon Workbench's own \"Delete\" only doing the strip, never a hide", () => {
        const diffFromAnotherTool = `<RibbonDiffXml>
  <CustomActions>
    <CustomAction Id="tn.Mscrm.SubGrid.contact.NewRecord.CustomAction" Location="grp.currency.Controls._children" Sequence="30">
      <CommandUIDefinition>
        <Button Id="Mscrm.SubGrid.contact.NewRecord" Command="Mscrm.NewRecordFromGrid" LabelText="New" Sequence="30" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
  </CustomActions>
  <Templates />
  <CommandDefinitions></CommandDefinitions>
  <RuleDefinitions>
    <TabDisplayRules />
    <DisplayRules></DisplayRules>
    <EnableRules></EnableRules>
  </RuleDefinitions>
  <HideCustomActions></HideCustomActions>
</RibbonDiffXml>`;
        const model = baseModel();
        model.tabs[0].groups[0].controls.push(
            { kind: 'Button', id: 'Mscrm.SubGrid.contact.NewRecord', label: 'New', toolTipTitle: '', toolTipDescription: '', status: 'reverted' },
        );
        const xml = mergeRibbonDiffXml(diffFromAnotherTool, model);
        assert.doesNotMatch(xml, /tn\.Mscrm\.SubGrid\.contact\.NewRecord\.CustomAction/, 'the competing customization must be stripped');
        // baseModel() has its own unrelated modified/deleted controls that legitimately produce their
        // own HideCustomActions -- check specifically that THIS element isn't one of them, rather than
        // asserting no HideCustomAction exists anywhere in the document.
        assert.doesNotMatch(xml, /CommandUIElementId="Mscrm\.SubGrid\.contact\.NewRecord"/, 'must NOT hide it -- reverted means "let the base show", not "hide it"');
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

    it('preserves an existing populated Templates section verbatim -- this editor has no UI to edit it and must never silently replace it with an empty one', () => {
        const diffWithTemplates = existingDiff.replace(
            '<Templates />',
            '<Templates><RibbonTemplates Id="Mscrm.Templates"><RibbonTemplate Id="custom.template"><CommandUIDefinition><Group /></CommandUIDefinition></RibbonTemplate></RibbonTemplates></Templates>',
        );
        const xml = mergeRibbonDiffXml(diffWithTemplates, baseModel());
        assert.match(xml, /<RibbonTemplate Id="custom\.template">/);
    });

    it('still emits an empty Templates section when there was none to preserve', () => {
        const xml = mergeRibbonDiffXml(existingDiff, baseModel());
        assert.match(xml, /<Templates \/>/);
    });
});

describe('findInvalidFlyoutAnchors', () => {
    function modelWithFlyout(flyout: RibbonControl): RibbonModel {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push(flyout);
        return model;
    }

    it('flags a FlyoutAnchor with no children (no Menu) and no PopulateQueryCommand', () => {
        const model = modelWithFlyout({
            kind: 'FlyoutAnchor', id: 'flyout.empty', label: 'Empty', toolTipTitle: '', toolTipDescription: '', status: 'added', controls: [],
        });
        const ids = findInvalidFlyoutAnchors(buildRibbonDiffFragments(model));
        assert.deepStrictEqual(ids, ['flyout.empty']);
    });

    it('does not flag a FlyoutAnchor that has at least one menu item', () => {
        const model = modelWithFlyout({
            kind: 'FlyoutAnchor', id: 'flyout.withmenu', label: 'With Menu', toolTipTitle: '', toolTipDescription: '', status: 'added',
            controls: [{
                kind: 'MenuSection', id: 'flyout.withmenu.section1', label: '', toolTipTitle: '', toolTipDescription: '', status: 'added',
                controls: [{ kind: 'Button', id: 'flyout.withmenu.item1', label: 'Item', toolTipTitle: '', toolTipDescription: '', status: 'added' }],
            }],
        });
        const ids = findInvalidFlyoutAnchors(buildRibbonDiffFragments(model));
        assert.deepStrictEqual(ids, []);
    });

    it('does not flag an unrelated Button', () => {
        const ids = findInvalidFlyoutAnchors(buildRibbonDiffFragments(baseModel()));
        assert.deepStrictEqual(ids, []);
    });

    it('flags a base-ribbon FlyoutAnchor incidentally re-emitted via a wholesale group re-serialize (e.g. reordering a sibling), even though this editor never touched the flyout itself', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push({
            kind: 'FlyoutAnchor', id: 'Mscrm.SubGrid.tn_regulation.ChangeDataSetControlButton', label: 'Change View',
            toolTipTitle: '', toolTipDescription: '', status: 'unchanged', controls: [],
        });
        model.tabs[0].groups[0].status = 'modified'; // e.g. group-level touch from a sibling reorder
        const ids = findInvalidFlyoutAnchors(buildRibbonDiffFragments(model));
        assert.deepStrictEqual(ids, ['Mscrm.SubGrid.tn_regulation.ChangeDataSetControlButton']);
    });
});

describe('findDuplicateCustomActionTargets', () => {
    it('flags an element declared by two different CustomAction wrappers -- e.g. this tool\'s own and a separately-named one from another tool', () => {
        const xml = `<RibbonDiffXml>
  <CustomActions>
    <CustomAction Id="tn.tn_regulation.new.button.Custom" Location="grp.Controls._children" Sequence="20">
      <CommandUIDefinition>
        <Button Id="tn.tn_regulation.new.button" LabelText="New" Sequence="20" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="tn.tn_regulation.new.button.CustomAction" Location="grp.Controls._children" Sequence="20">
      <CommandUIDefinition>
        <Button Id="tn.tn_regulation.new.button" LabelText="New" Sequence="20" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
  </CustomActions>
</RibbonDiffXml>`;
        const duplicates = findDuplicateCustomActionTargets(xml);
        assert.deepStrictEqual(duplicates, [
            { elementId: 'tn.tn_regulation.new.button', wrapperIds: ['tn.tn_regulation.new.button.Custom', 'tn.tn_regulation.new.button.CustomAction'] },
        ]);
    });

    it('does not flag elements declared exactly once', () => {
        const xml = `<RibbonDiffXml>
  <CustomActions>
    <CustomAction Id="a.Custom" Location="grp.Controls._children" Sequence="10">
      <CommandUIDefinition>
        <Button Id="a" LabelText="A" Sequence="10" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="b.Custom" Location="grp.Controls._children" Sequence="20">
      <CommandUIDefinition>
        <Button Id="b" LabelText="B" Sequence="20" TemplateAlias="o2" />
      </CommandUIDefinition>
    </CustomAction>
  </CustomActions>
</RibbonDiffXml>`;
        assert.deepStrictEqual(findDuplicateCustomActionTargets(xml), []);
    });

    it('returns an empty array for an empty or missing CustomActions section', () => {
        assert.deepStrictEqual(findDuplicateCustomActionTargets('<RibbonDiffXml><CustomActions /></RibbonDiffXml>'), []);
        assert.deepStrictEqual(findDuplicateCustomActionTargets('<RibbonDiffXml></RibbonDiffXml>'), []);
    });
});
