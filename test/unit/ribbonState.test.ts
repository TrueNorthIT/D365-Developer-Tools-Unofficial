import * as assert from 'assert';
import {
  buildRibbonElementId, collectAllIds, displayText, extractNameSegment, firstUnusedName, kindSuffixFor, locationOf, reducer, slugify,
  type EditorState, type PromptRequest,
} from '../../src/webview-ribbon/ribbonState';
import type { RibbonModel } from '../../src/webview-ribbon/protocol';

function baseModel(): RibbonModel {
    return {
        tabs: [
            {
                id: 'Mscrm.HomepageGrid.contact.MainTab',
                title: 'Contacts',
                status: 'unchanged',
                groups: [
                    {
                        id: 'grp1',
                        title: 'Management',
                        status: 'unchanged',
                        controls: [
                            { kind: 'Button', id: 'btn.no.command', label: 'No Command', toolTipTitle: '', toolTipDescription: '', status: 'unchanged' },
                            { kind: 'Button', id: 'btn.with.command', label: 'Has Command', toolTipTitle: '', toolTipDescription: '', status: 'unchanged', commandId: 'cmd1' },
                        ],
                    },
                ],
            },
        ],
        commandDefinitions: [
            { id: 'cmd1', enableRules: ['rule.enable1'], displayRules: [], actions: [], status: 'unchanged' },
        ],
        enableRules: [
            { id: 'rule.enable1', xml: '<EnableRule Id="rule.enable1" />', status: 'unchanged' },
        ],
        displayRules: [],
        locLabels: {},
    };
}

function stateWithModel(model: RibbonModel): EditorState {
    return {
        entityLogicalName: 'contact',
        entityDisplayName: 'Contact',
        publisherPrefix: 'new',
        model,
        loading: false,
        error: null,
        selection: null,
    };
}

describe('locationOf', () => {
    it('categorizes HomepageGrid tab ids', () => {
        assert.strictEqual(locationOf('Mscrm.HomepageGrid.contact.MainTab'), 'Home Grid');
    });
    it('categorizes Form tab ids', () => {
        assert.strictEqual(locationOf('Mscrm.Form.contact.MainTab'), 'Main Form');
    });
    it('categorizes SubGrid tab ids', () => {
        assert.strictEqual(locationOf('Mscrm.SubGrid.contact.MainTab'), 'Sub-Grid');
    });
    it('falls back to Other for unrecognized tab ids', () => {
        assert.strictEqual(locationOf('LinkedInExtensions.contact.SomeTab'), 'Other');
    });
});

describe('displayText', () => {
    it('returns a literal label unchanged', () => {
        assert.strictEqual(displayText('Contacts', 'Mscrm.HomepageGrid.contact.MainTab'), 'Contacts');
    });

    it('derives a readable fallback from the id for an unresolved $LocLabels: reference, stripping generic location/type segments', () => {
        assert.strictEqual(displayText('$LocLabels:tn.contact.Export.SubGrid.Button.LabelText', 'tn.contact.Export.SubGrid.Button'), 'Export');
    });

    it('derives a readable fallback and splits camelCase for an unresolved $Resources: reference', () => {
        assert.strictEqual(displayText('$Resources:Ribbon.HomepageGrid.MainTab.Management', 'msdyn.HomepageGrid.contact.OpenFocusedView.Button'), 'Open Focused View');
    });

    it('falls back to the full id (still humanized) when every segment is generic', () => {
        assert.strictEqual(displayText('$Resources:Whatever', 'HomepageGrid.MainTab'), 'Homepage Grid.Main Tab');
    });

    it('treats an empty label as unresolved too', () => {
        assert.strictEqual(displayText('', 'Mscrm.HomepageGrid.contact.Activate'), 'Activate');
    });
});

describe("ribbonState reducer: 'ribbonModel' inbound message", () => {
    it('stores publisherPrefix from the message alongside the model', () => {
        const model = baseModel();
        const next = reducer(
            { entityLogicalName: '', entityDisplayName: '', ribbonLocationLabel: '', publisherPrefix: '', model: null, loading: true, error: null, selection: null },
            { type: 'ribbonModel', entityLogicalName: 'contact', entityDisplayName: 'Contact', ribbonLocationLabel: 'All', publisherPrefix: 'new', model },
        );
        assert.strictEqual(next.publisherPrefix, 'new');
        assert.strictEqual(next.loading, false);
    });
});

describe('slugify', () => {
    it('lowercases and strips spaces/punctuation', () => {
        assert.strictEqual(slugify('My Action!'), 'myaction');
    });
    it('keeps underscores and digits', () => {
        assert.strictEqual(slugify('My_Action_2'), 'my_action_2');
    });
    it('trims surrounding whitespace before slugifying', () => {
        assert.strictEqual(slugify('  Spaced  '), 'spaced');
    });
});

describe('buildRibbonElementId', () => {
    it('joins prefix, entity, slugified name, and kind suffix with dots', () => {
        assert.strictEqual(buildRibbonElementId('new', 'account', 'My Action', 'button'), 'new.account.myaction.button');
    });
});

describe('kindSuffixFor', () => {
    const cases: Array<[PromptRequest, string]> = [
        [{ kind: 'tab' }, 'tab'],
        [{ kind: 'group', tabId: 't1' }, 'group'],
        [{ kind: 'control', tabId: 't1', groupId: 'g1', controlKind: 'Button' }, 'button'],
        [{ kind: 'control', tabId: 't1', groupId: 'g1', controlKind: 'SplitButton' }, 'splitbutton'],
        [{ kind: 'control', tabId: 't1', groupId: 'g1', controlKind: 'FlyoutAnchor' }, 'flyoutanchor'],
        [{ kind: 'command', controlId: 'c1' }, 'command'],
        [{ kind: 'rule', commandId: 'cmd1', ruleType: 'enable' }, 'enablerule'],
        [{ kind: 'rule', commandId: 'cmd1', ruleType: 'display' }, 'displayrule'],
    ];
    for (const [request, expected] of cases) {
        it(`maps ${request.kind}${'controlKind' in request ? `/${request.controlKind}` : ''}${'ruleType' in request ? `/${request.ruleType}` : ''} to "${expected}"`, () => {
            assert.strictEqual(kindSuffixFor(request), expected);
        });
    }
});

describe('firstUnusedName', () => {
    it('returns the base name unchanged when it is not taken', () => {
        assert.strictEqual(firstUnusedName('myaction', () => false), 'myaction');
    });

    it('appends 2, 3, ... until it finds one that is not taken', () => {
        const taken = new Set(['myaction', 'myaction2', 'myaction3']);
        assert.strictEqual(firstUnusedName('myaction', c => taken.has(c)), 'myaction4');
    });

    it('returns an empty base unchanged (nothing to de-duplicate)', () => {
        assert.strictEqual(firstUnusedName('', () => true), '');
    });
});

describe('extractNameSegment', () => {
    it('recovers the name segment from an id matching this editor\'s own shape', () => {
        assert.strictEqual(extractNameSegment('new.account.myaction.button', 'new', 'account', 'button'), 'myaction');
    });

    it('returns undefined when the id does not start with the expected prefix', () => {
        assert.strictEqual(extractNameSegment('Mscrm.HomepageGrid.contact.MainTab', 'new', 'account', 'tab'), undefined);
    });

    it('returns undefined when the id does not end with the expected kind suffix', () => {
        assert.strictEqual(extractNameSegment('new.account.myaction.button', 'new', 'account', 'command'), undefined);
    });

    it('returns undefined when there is no publisher prefix configured', () => {
        assert.strictEqual(extractNameSegment('new.account.myaction.button', '', 'account', 'button'), undefined);
    });

    it('returns undefined when the name segment would be empty', () => {
        assert.strictEqual(extractNameSegment('new.account..button', 'new', 'account', 'button'), undefined);
    });
});

describe('collectAllIds', () => {
    it('collects tab, group, control (incl. nested), command, and rule ids', () => {
        const model = baseModel();
        const ids = collectAllIds(model);
        assert.ok(ids.has('Mscrm.HomepageGrid.contact.MainTab'));
        assert.ok(ids.has('grp1'));
        assert.ok(ids.has('btn.no.command'));
        assert.ok(ids.has('btn.with.command'));
        assert.ok(ids.has('cmd1'));
        assert.ok(ids.has('rule.enable1'));
    });

    it('collects nested (flyout menu) control ids too', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push({
            kind: 'FlyoutAnchor', id: 'flyout1', label: 'Flyout', toolTipTitle: '', toolTipDescription: '', status: 'unchanged',
            controls: [{ kind: 'MenuSection', id: 'section1', label: '', toolTipTitle: '', toolTipDescription: '', status: 'unchanged', controls: [
                { kind: 'Button', id: 'nested.btn', label: 'Nested', toolTipTitle: '', toolTipDescription: '', status: 'unchanged' },
            ] }],
        });
        const ids = collectAllIds(model);
        assert.ok(ids.has('flyout1'));
        assert.ok(ids.has('section1'));
        assert.ok(ids.has('nested.btn'));
    });
});

describe('ribbonState reducer: addTab/addGroup/addControl (ids supplied by the caller, see NamePromptDialog)', () => {
    it('addTab adds a tab with the given id/title and selects it', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addTab', id: 'new.contact.mytab.tab', title: 'My Tab' });

        const tab = next.model!.tabs.find(t => t.id === 'new.contact.mytab.tab')!;
        assert.ok(tab, 'expected the new tab to exist');
        assert.strictEqual(tab.title, 'My Tab');
        assert.strictEqual(tab.status, 'added');
        assert.deepStrictEqual(next.selection, { kind: 'tab', id: 'new.contact.mytab.tab' });
    });

    it('addGroup adds a group to the given tab with the given id/title and selects it', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addGroup', tabId: 'Mscrm.HomepageGrid.contact.MainTab', id: 'new.contact.mygroup.group', title: 'My Group' });

        const group = next.model!.tabs[0].groups.find(g => g.id === 'new.contact.mygroup.group')!;
        assert.ok(group, 'expected the new group to exist');
        assert.strictEqual(group.title, 'My Group');
        assert.strictEqual(group.status, 'added');
        assert.deepStrictEqual(next.selection, { kind: 'group', tabId: 'Mscrm.HomepageGrid.contact.MainTab', id: 'new.contact.mygroup.group' });
    });

    it('addControl adds a control with the given id/title to the given group and selects it', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addControl', tabId: 'Mscrm.HomepageGrid.contact.MainTab', groupId: 'grp1', kind: 'Button', id: 'new.contact.mybutton.button', title: 'My Button' });

        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'new.contact.mybutton.button')!;
        assert.ok(control, 'expected the new control to exist');
        assert.strictEqual(control.label, 'My Button');
        assert.strictEqual(control.status, 'added');
        assert.deepStrictEqual(next.selection, { kind: 'control', tabId: 'Mscrm.HomepageGrid.contact.MainTab', groupId: 'grp1', id: 'new.contact.mybutton.button' });
    });

    it('addControl gives a FlyoutAnchor a child MenuSection using the supplied menuSectionId', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, {
            type: 'local/addControl', tabId: 'Mscrm.HomepageGrid.contact.MainTab', groupId: 'grp1', kind: 'FlyoutAnchor',
            id: 'new.contact.myflyout.flyoutanchor', title: 'My Flyout', menuSectionId: 'new.contact.myflyout.menusection',
        });

        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'new.contact.myflyout.flyoutanchor')!;
        assert.strictEqual(control.controls?.[0].id, 'new.contact.myflyout.menusection');
        assert.strictEqual(control.controls?.[0].kind, 'MenuSection');
    });

    it('addControl creates and links a command when the caller supplies a commandId (Button/SplitButton, via App.tsx)', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, {
            type: 'local/addControl', tabId: 'Mscrm.HomepageGrid.contact.MainTab', groupId: 'grp1', kind: 'Button',
            id: 'new.contact.mybutton.button', title: 'My Button', commandId: 'new.contact.mybutton.command',
        });

        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'new.contact.mybutton.button')!;
        assert.strictEqual(control.commandId, 'new.contact.mybutton.command');

        const command = next.model!.commandDefinitions.find(c => c.id === 'new.contact.mybutton.command')!;
        assert.ok(command, 'expected the auto-created command definition to exist');
        assert.strictEqual(command.status, 'added');
        assert.deepStrictEqual(command.enableRules, []);
    });

    it('addControl leaves commandId unset (and creates no command) when the caller omits it (e.g. FlyoutAnchor)', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, {
            type: 'local/addControl', tabId: 'Mscrm.HomepageGrid.contact.MainTab', groupId: 'grp1', kind: 'FlyoutAnchor',
            id: 'new.contact.myflyout.flyoutanchor', title: 'My Flyout', menuSectionId: 'new.contact.myflyout.menusection',
        });

        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'new.contact.myflyout.flyoutanchor')!;
        assert.strictEqual(control.commandId, undefined);
        assert.strictEqual(next.model!.commandDefinitions.length, state.model!.commandDefinitions.length);
    });
});

describe('ribbonState reducer: createCommandForControl', () => {
    it('creates a command definition with the given id and assigns it to the control', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/createCommandForControl', controlId: 'btn.no.command', id: 'new.contact.mycommand.command' });

        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.no.command')!;
        assert.strictEqual(control.commandId, 'new.contact.mycommand.command');
        assert.strictEqual(control.status, 'modified');

        const command = next.model!.commandDefinitions.find(c => c.id === 'new.contact.mycommand.command')!;
        assert.ok(command, 'expected the new command definition to exist');
        assert.strictEqual(command.status, 'added');
        assert.deepStrictEqual(command.enableRules, []);
    });

    it('does nothing when the control id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/createCommandForControl', controlId: 'does.not.exist', id: 'new.contact.mycommand.command' });
        assert.strictEqual(next.model!.commandDefinitions.length, 1);
    });
});

describe('ribbonState reducer: addRuleToCommand', () => {
    it('creates a rule with the given id and appends it to the command enable rules', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addRuleToCommand', commandId: 'cmd1', ruleType: 'enable', id: 'new.contact.myrule.enablerule' });

        const command = next.model!.commandDefinitions.find(c => c.id === 'cmd1')!;
        assert.strictEqual(command.enableRules.length, 2);
        assert.strictEqual(command.status, 'modified');
        assert.strictEqual(command.enableRules[1], 'new.contact.myrule.enablerule');

        const rule = next.model!.enableRules.find(r => r.id === 'new.contact.myrule.enablerule')!;
        assert.ok(rule, 'expected the new enable rule to exist in the model');
        assert.strictEqual(rule.status, 'added');
        assert.ok(rule.xml.includes('EnableRule'));
    });

    it('creates a rule with the given id and appends it to the command display rules', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addRuleToCommand', commandId: 'cmd1', ruleType: 'display', id: 'new.contact.myrule.displayrule' });

        const command = next.model!.commandDefinitions.find(c => c.id === 'cmd1')!;
        assert.strictEqual(command.displayRules.length, 1);
        const rule = next.model!.displayRules.find(r => r.id === command.displayRules[0])!;
        assert.ok(rule);
        assert.ok(rule.xml.includes('DisplayRule'));
    });

    it('does nothing when the command id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addRuleToCommand', commandId: 'does.not.exist', ruleType: 'enable', id: 'new.contact.myrule.enablerule' });
        assert.strictEqual(next.model!.enableRules.length, 1);
    });
});

describe('ribbonState reducer: removeRuleFromCommand', () => {
    it('unlinks the rule from the command and drops the now-unreferenced rule definition', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/removeRuleFromCommand', commandId: 'cmd1', ruleType: 'enable', ruleId: 'rule.enable1' });

        const command = next.model!.commandDefinitions.find(c => c.id === 'cmd1')!;
        assert.deepStrictEqual(command.enableRules, []);
        assert.strictEqual(command.status, 'modified');
        assert.strictEqual(next.model!.enableRules.length, 0);
    });

    it('keeps the rule definition when another command still references it', () => {
        const model = baseModel();
        model.commandDefinitions.push({ id: 'cmd2', enableRules: ['rule.enable1'], displayRules: [], actions: [], status: 'unchanged' });
        const next = reducer(stateWithModel(model), { type: 'local/removeRuleFromCommand', commandId: 'cmd1', ruleType: 'enable', ruleId: 'rule.enable1' });

        const cmd1 = next.model!.commandDefinitions.find(c => c.id === 'cmd1')!;
        const cmd2 = next.model!.commandDefinitions.find(c => c.id === 'cmd2')!;
        assert.deepStrictEqual(cmd1.enableRules, []);
        assert.deepStrictEqual(cmd2.enableRules, ['rule.enable1']);
        assert.strictEqual(next.model!.enableRules.length, 1, 'rule definition should survive since cmd2 still references it');
    });

    it('does nothing when the command id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/removeRuleFromCommand', commandId: 'does.not.exist', ruleType: 'enable', ruleId: 'rule.enable1' });
        assert.strictEqual(next.model!.enableRules.length, 1);
    });
});

describe('ribbonState reducer: reorderControl', () => {
    it('moves the control before the target and marks every repositioned control modified so each gets a fresh Sequence on export', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/reorderControl', groupId: 'grp1', controlId: 'btn.with.command', beforeControlId: 'btn.no.command' });

        const controls = next.model!.tabs[0].groups[0].controls;
        assert.deepStrictEqual(controls.map(c => c.id), ['btn.with.command', 'btn.no.command']);
        assert.strictEqual(controls[0].status, 'modified');
        assert.strictEqual(controls[1].status, 'modified');
    });

    it('appends to the end when beforeControlId is null', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/reorderControl', groupId: 'grp1', controlId: 'btn.no.command', beforeControlId: null });

        const controls = next.model!.tabs[0].groups[0].controls;
        assert.deepStrictEqual(controls.map(c => c.id), ['btn.with.command', 'btn.no.command']);
    });

    it('does nothing when dropped back at its original position', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/reorderControl', groupId: 'grp1', controlId: 'btn.no.command', beforeControlId: 'btn.with.command' });

        const controls = next.model!.tabs[0].groups[0].controls;
        assert.deepStrictEqual(controls.map(c => c.id), ['btn.no.command', 'btn.with.command']);
        assert.ok(controls.every(c => c.status === 'unchanged'), 'no-op reorder should not touch sibling statuses');
    });

    it('does nothing when controlId equals beforeControlId', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/reorderControl', groupId: 'grp1', controlId: 'btn.no.command', beforeControlId: 'btn.no.command' });

        const controls = next.model!.tabs[0].groups[0].controls;
        assert.deepStrictEqual(controls.map(c => c.id), ['btn.no.command', 'btn.with.command']);
        assert.ok(controls.every(c => c.status === 'unchanged'));
    });

    it('does nothing when the group id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/reorderControl', groupId: 'does.not.exist', controlId: 'btn.no.command', beforeControlId: null });

        const controls = next.model!.tabs[0].groups[0].controls;
        assert.deepStrictEqual(controls.map(c => c.id), ['btn.no.command', 'btn.with.command']);
    });

    it('leaves deleted siblings untouched while reordering the rest', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push({ kind: 'Button', id: 'btn.deleted', label: 'Gone', toolTipTitle: '', toolTipDescription: '', status: 'deleted' });
        const next = reducer(stateWithModel(model), { type: 'local/reorderControl', groupId: 'grp1', controlId: 'btn.with.command', beforeControlId: 'btn.no.command' });

        const deleted = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.deleted')!;
        assert.strictEqual(deleted.status, 'deleted');
    });
});

describe('ribbonState reducer: deleteControl (delete-or-hide, whichever applies)', () => {
    it('marks an unchanged (built-in or prior-customization) control deleted, not removed -- resolved at publish time', () => {
        const next = reducer(stateWithModel(baseModel()), { type: 'local/deleteControl', controlId: 'btn.no.command' });
        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.no.command')!;
        assert.strictEqual(control.status, 'deleted');
    });

    it('restores a deleted control back to unchanged when the same action is dispatched again', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[0].status = 'deleted';
        const next = reducer(stateWithModel(model), { type: 'local/deleteControl', controlId: 'btn.no.command' });
        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.no.command')!;
        assert.strictEqual(control.status, 'unchanged');
    });

    it('removes a control added this session entirely, instead of marking it deleted', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push({ kind: 'Button', id: 'btn.new', label: 'New', toolTipTitle: '', toolTipDescription: '', status: 'added' });
        const next = reducer(stateWithModel(model), { type: 'local/deleteControl', controlId: 'btn.new' });
        const controls = next.model!.tabs[0].groups[0].controls;
        assert.ok(!controls.some(c => c.id === 'btn.new'));
    });

    it('marks a modified control deleted, discarding its in-progress edit', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[1].status = 'modified';
        const next = reducer(stateWithModel(model), { type: 'local/deleteControl', controlId: 'btn.with.command' });
        assert.strictEqual(next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.with.command')!.status, 'deleted');
    });

    it('does not depend on the current selection -- acts on whichever control id is passed', () => {
        const state = { ...stateWithModel(baseModel()), selection: { kind: 'control' as const, tabId: 'Mscrm.HomepageGrid.contact.MainTab', groupId: 'grp1', id: 'btn.with.command' } };
        const next = reducer(state, { type: 'local/deleteControl', controlId: 'btn.no.command' });

        const toggled = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.no.command')!;
        const untouched = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.with.command')!;
        assert.strictEqual(toggled.status, 'deleted');
        assert.strictEqual(untouched.status, 'unchanged');
        assert.deepStrictEqual(next.selection, state.selection, 'selection should be left as-is, unlike deleteSelected');
    });

    it('does nothing when the control id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/deleteControl', controlId: 'does.not.exist' });
        assert.deepStrictEqual(next.model, state.model);
    });
});
