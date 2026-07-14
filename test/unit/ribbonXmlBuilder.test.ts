import * as assert from 'assert';
import { buildRibbonDiffXml } from '../../src/ribbon/ribbonXmlBuilder';
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
            { id: 'cmd.added', enableRules: ['rule.enable1'], displayRules: [], actions: [{ type: 'JavaScriptFunction', library: '$webresource:lib.js', functionName: 'run', params: ['a'] }], status: 'added' },
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

    it('includes added/modified rule fragments under RuleDefinitions', () => {
        const xml = buildRibbonDiffXml(baseModel());
        assert.match(xml, /<EnableRules>[\s\S]*CrmClientTypeRule[\s\S]*<\/EnableRules>/);
        assert.match(xml, /<DisplayRules>[\s\S]*CustomRule[\s\S]*<\/DisplayRules>/);
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
