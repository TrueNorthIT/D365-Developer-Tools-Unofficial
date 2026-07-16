import * as assert from 'assert';
import { displayText, locationOf, reducer, type EditorState } from '../../src/webview-ribbon/ribbonState';
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

describe('ribbonState reducer: createCommandForControl', () => {
    it('creates a new command definition and assigns it to the control', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/createCommandForControl', controlId: 'btn.no.command' });

        const control = next.model!.tabs[0].groups[0].controls.find(c => c.id === 'btn.no.command')!;
        assert.ok(control.commandId, 'expected a commandId to be assigned');
        assert.strictEqual(control.status, 'modified');

        const command = next.model!.commandDefinitions.find(c => c.id === control.commandId)!;
        assert.ok(command, 'expected the new command definition to exist');
        assert.strictEqual(command.status, 'added');
        assert.deepStrictEqual(command.enableRules, []);
    });

    it('does nothing when the control id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/createCommandForControl', controlId: 'does.not.exist' });
        assert.strictEqual(next.model!.commandDefinitions.length, 1);
    });
});

describe('ribbonState reducer: addRuleToCommand', () => {
    it('creates a new rule and appends its id to the command enable rules', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addRuleToCommand', commandId: 'cmd1', ruleType: 'enable' });

        const command = next.model!.commandDefinitions.find(c => c.id === 'cmd1')!;
        assert.strictEqual(command.enableRules.length, 2);
        assert.strictEqual(command.status, 'modified');

        const newRuleId = command.enableRules[1];
        const rule = next.model!.enableRules.find(r => r.id === newRuleId)!;
        assert.ok(rule, 'expected the new enable rule to exist in the model');
        assert.strictEqual(rule.status, 'added');
        assert.ok(rule.xml.includes('EnableRule'));
    });

    it('creates a new rule and appends its id to the command display rules', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addRuleToCommand', commandId: 'cmd1', ruleType: 'display' });

        const command = next.model!.commandDefinitions.find(c => c.id === 'cmd1')!;
        assert.strictEqual(command.displayRules.length, 1);
        const rule = next.model!.displayRules.find(r => r.id === command.displayRules[0])!;
        assert.ok(rule);
        assert.ok(rule.xml.includes('DisplayRule'));
    });

    it('does nothing when the command id is not found', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/addRuleToCommand', commandId: 'does.not.exist', ruleType: 'enable' });
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
    it('moves the control before the target and marks only the moved control modified', () => {
        const state = stateWithModel(baseModel());
        const next = reducer(state, { type: 'local/reorderControl', groupId: 'grp1', controlId: 'btn.with.command', beforeControlId: 'btn.no.command' });

        const controls = next.model!.tabs[0].groups[0].controls;
        assert.deepStrictEqual(controls.map(c => c.id), ['btn.with.command', 'btn.no.command']);
        assert.strictEqual(controls[0].status, 'modified');
        assert.strictEqual(controls[1].status, 'unchanged');
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
