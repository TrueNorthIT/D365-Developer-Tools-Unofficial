import { XMLBuilder } from 'fast-xml-parser';
import type { RibbonCommandDefinition, RibbonControl, RibbonGroup, RibbonModel, RibbonTab } from './ribbonModel';

// Builds a `RibbonDiffXml` document from a RibbonModel that's been edited in the webview (each node
// tagged 'added' | 'modified' | 'deleted' | 'unchanged'). Mirrors how Ribbon Workbench itself
// represents changes: new nodes become <CustomAction>s anchored at their parent's `._children`
// location; edits to an existing node are a <HideCustomAction> for the original plus a
// <CustomAction> re-adding the edited version at the same location; deletions are just the Hide.
//
// Location strings use the common Ribbon Workbench anchor convention (`<parentId>.Groups._children`,
// `<parentId>.Controls._children`, `Mscrm.Tabs._children`) — a reasonable default anchor, refined
// once real import/publish support lands. This module has no `vscode` import and produces text only;
// nothing here talks to Dataverse.

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressEmptyNode: true });

export function buildRibbonDiffXml(model: RibbonModel): string {
    const customActions: string[] = [];
    const hideCustomActions: string[] = [];
    let sequence = 100;

    for (const tab of model.tabs) {
        if (tab.status === 'added') {
            customActions.push(customAction(`${tab.id}.Custom`, 'Mscrm.Tabs._children', sequence++, serializeTab(tab)));
            continue; // groups/controls are already nested inside the serialized tab
        }
        if (tab.status === 'modified') {
            hideCustomActions.push(hideCustomAction(tab.id, 'Mscrm.Tabs._children'));
            customActions.push(customAction(`${tab.id}.Custom`, 'Mscrm.Tabs._children', sequence++, serializeTab(tab)));
            continue;
        }
        if (tab.status === 'deleted') {
            hideCustomActions.push(hideCustomAction(tab.id, 'Mscrm.Tabs._children'));
            continue;
        }

        const groupsLocation = `${tab.id}.Groups._children`;
        for (const group of tab.groups) {
            if (group.status === 'added') {
                customActions.push(customAction(`${group.id}.Custom`, groupsLocation, sequence++, serializeGroup(group)));
                continue;
            }
            if (group.status === 'modified') {
                hideCustomActions.push(hideCustomAction(group.id, groupsLocation));
                customActions.push(customAction(`${group.id}.Custom`, groupsLocation, sequence++, serializeGroup(group)));
                continue;
            }
            if (group.status === 'deleted') {
                hideCustomActions.push(hideCustomAction(group.id, groupsLocation));
                continue;
            }

            const controlsLocation = `${group.id}.Controls._children`;
            for (const control of group.controls) {
                if (control.status === 'added') {
                    customActions.push(customAction(`${control.id}.Custom`, controlsLocation, sequence++, serializeControl(control)));
                } else if (control.status === 'modified') {
                    hideCustomActions.push(hideCustomAction(control.id, controlsLocation));
                    customActions.push(customAction(`${control.id}.Custom`, controlsLocation, sequence++, serializeControl(control)));
                } else if (control.status === 'deleted') {
                    hideCustomActions.push(hideCustomAction(control.id, controlsLocation));
                }
            }
        }
    }

    const commandDefinitions = model.commandDefinitions
        .filter(c => c.status === 'added' || c.status === 'modified')
        .map(serializeCommandDefinition);
    const enableRules = model.enableRules.filter(r => r.status === 'added' || r.status === 'modified').map(r => r.xml.trim());
    const displayRules = model.displayRules.filter(r => r.status === 'added' || r.status === 'modified').map(r => r.xml.trim());

    return [
        '<RibbonDiffXml>',
        '  <CustomActions>',
        ...indentAll(customActions, 4),
        '  </CustomActions>',
        '  <Templates />',
        '  <CommandDefinitions>',
        ...indentAll(commandDefinitions, 4),
        '  </CommandDefinitions>',
        '  <RuleDefinitions>',
        '    <TabDisplayRules />',
        '    <DisplayRules>',
        ...indentAll(displayRules, 6),
        '    </DisplayRules>',
        '    <EnableRules>',
        ...indentAll(enableRules, 6),
        '    </EnableRules>',
        '  </RuleDefinitions>',
        '  <HideCustomActions>',
        ...indentAll(hideCustomActions, 4),
        '  </HideCustomActions>',
        '</RibbonDiffXml>',
    ].join('\n');
}

// ── Node serialization (RibbonModel -> XML fragment) ─────────────────────────

function serializeTab(tab: RibbonTab): string {
    const obj: Record<string, unknown> = { '@_Id': tab.id };
    if (tab.title) { obj['@_Title'] = tab.title; }
    const groups = tab.groups.filter(g => g.status !== 'deleted');
    if (groups.length) { obj.Groups = { Group: groups.map(groupToObj) }; }
    return builder.build({ Tab: obj }) as string;
}

function serializeGroup(group: RibbonGroup): string {
    return builder.build({ Group: groupToObj(group) }) as string;
}

function groupToObj(group: RibbonGroup): Record<string, unknown> {
    const obj: Record<string, unknown> = { '@_Id': group.id };
    if (group.title) { obj['@_Title'] = group.title; }
    const controls = controlsToObj(group.controls);
    if (controls) { obj.Controls = controls; }
    return obj;
}

function serializeControl(control: RibbonControl): string {
    return builder.build({ [control.kind]: controlToObj(control) }) as string;
}

function controlToObj(control: RibbonControl): Record<string, unknown> {
    const obj: Record<string, unknown> = { '@_Id': control.id };
    if (control.label) { obj['@_LabelText'] = control.label; }
    if (control.toolTipTitle) { obj['@_ToolTipTitle'] = control.toolTipTitle; }
    if (control.toolTipDescription) { obj['@_ToolTipDescription'] = control.toolTipDescription; }
    if (control.image16) { obj['@_Image16by16'] = control.image16; }
    if (control.image32) { obj['@_Image32by32'] = control.image32; }
    if (control.modernImage) { obj['@_ModernImage'] = control.modernImage; }
    if (control.commandId) { obj['@_Command'] = control.commandId; }

    const children = control.controls?.filter(c => c.status !== 'deleted') ?? [];
    if (control.kind === 'FlyoutAnchor' && children.length) {
        obj.Menu = { MenuSection: children.map(section => ({
            '@_Id': section.id,
            Controls: controlsToObj(section.controls ?? []),
        })) };
    } else if (control.kind === 'MenuSection' && children.length) {
        obj.Controls = controlsToObj(children);
    }
    return obj;
}

function controlsToObj(controls: RibbonControl[]): Record<string, unknown> | undefined {
    const grouped: Record<string, unknown[]> = {};
    for (const control of controls) {
        if (control.status === 'deleted') { continue; }
        (grouped[control.kind] ??= []).push(controlToObj(control));
    }
    return Object.keys(grouped).length ? grouped : undefined;
}

function serializeCommandDefinition(cmd: RibbonCommandDefinition): string {
    const obj: Record<string, unknown> = { '@_Id': cmd.id };
    if (cmd.enableRules.length) { obj.EnableRules = { EnableRule: cmd.enableRules.map(id => ({ '@_Id': id })) }; }
    if (cmd.displayRules.length) { obj.DisplayRules = { DisplayRule: cmd.displayRules.map(id => ({ '@_Id': id })) }; }
    if (cmd.actions.length) {
        const actions: Record<string, unknown[]> = {};
        for (const action of cmd.actions) {
            if (action.type === 'JavaScriptFunction') {
                (actions.JavaScriptFunction ??= []).push({
                    '@_Library': action.library,
                    '@_FunctionName': action.functionName,
                    ...(action.params.length ? { CrmParameter: action.params.map(v => ({ '@_Value': v })) } : {}),
                });
            } else if (action.type === 'Url') {
                (actions.Url ??= []).push({ '@_Address': action.address });
            }
            // 'Raw' actions preserved verbatim aren't representable via the object builder; they're
            // dropped here since CommandDefinition edits always originate from structured actions in
            // this editor's UI (raw actions pass through unmodified via 'unchanged' commands, which
            // aren't emitted into the diff at all).
        }
        obj.Actions = actions;
    }
    return builder.build({ CommandDefinition: obj }) as string;
}

// ── CustomAction / HideCustomAction wrappers ─────────────────────────────────

function customAction(id: string, location: string, sequence: number, innerXml: string): string {
    return `<CustomAction Id="${escapeAttr(id)}" Location="${escapeAttr(location)}" Sequence="${sequence}">\n${indent(innerXml.trim(), 2)}\n</CustomAction>`;
}

function hideCustomAction(targetId: string, location: string): string {
    return `<HideCustomAction Id="${escapeAttr(`${targetId}.Hide`)}" Location="${escapeAttr(location)}" CommandUIElementId="${escapeAttr(targetId)}" />`;
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return text.split('\n').map(line => pad + line).join('\n');
}

function indentAll(fragments: string[], spaces: number): string[] {
    return fragments.flatMap(f => indent(f, spaces).split('\n'));
}
