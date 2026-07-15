import type { InboundMessage, RibbonAction, RibbonCommandDefinition, RibbonControl, RibbonGroup, RibbonModel, RibbonRuleRaw, RibbonTab } from './protocol';
import { defaultRuleCondition, serializeRuleCondition } from './ruleCondition';

// Reducer + pure helpers for the ribbon editor's in-memory edit state. All edits mutate a
// structuredClone of the last-known model and tag the touched node's `status`, so
// buildRibbonDiffXml (extension-side) can turn the snapshot back into a diff on export. Kept as
// plain functions (no React) so the tree-walking logic is easy to reason about independent of
// rendering.

export type Selection =
  | { kind: 'tab'; id: string }
  | { kind: 'group'; tabId: string; id: string }
  | { kind: 'control'; tabId: string; groupId: string; id: string }
  | null;

export type Location = 'Home Grid' | 'Sub-Grid' | 'Main Form' | 'Other';

// Real tab ids encode location by substring (confirmed against a live capture, e.g.
// "Mscrm.HomepageGrid.contact.MainTab" vs "Mscrm.Form.contact.MainTab") — a display-only grouping
// for the location filter, not a schema concept.
export function locationOf(tabId: string): Location {
  if (tabId.includes('HomepageGrid')) { return 'Home Grid'; }
  if (tabId.includes('SubGrid')) { return 'Sub-Grid'; }
  if (tabId.includes('Form')) { return 'Main Form'; }
  return 'Other';
}

// Ribbon labels are frequently unresolved $LocLabels:/$Resources: references — RetrieveEntityRibbon's
// effective ribbon ships no label dictionary to resolve them against (see ribbonXmlParser.ts). Showing
// the raw reference token verbatim in the read-only preview is both unreadable and, being one long
// unbroken string, prone to overflowing a fixed-width tile into its neighbors. Fall back to a
// human-readable guess derived from the element's own Id instead. This only affects the preview —
// NodeEditor's editable Label/Title fields still show/edit the real underlying value.
const GENERIC_ID_SEGMENTS = new Set([
  'Button', 'SplitButton', 'MenuSection', 'FlyoutAnchor', 'Menu',
  'SubGrid', 'HomepageGrid', 'Form', 'MainTab', 'Grid', 'Tab',
]);

export function displayText(rawLabel: string, id: string): string {
  const isUnresolved = !rawLabel || rawLabel.startsWith('$LocLabels:') || rawLabel.startsWith('$Resources:');
  if (!isUnresolved) { return rawLabel; }

  const segments = id.split('.').filter(s => s && !GENERIC_ID_SEGMENTS.has(s));
  const last = segments[segments.length - 1] || id;
  return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').trim();
}

export interface EditorState {
  entityLogicalName: string;
  entityDisplayName: string;
  ribbonLocationLabel: string;
  model: RibbonModel | null;
  loading: boolean;
  error: string | null;
  selection: Selection;
}

export const initialState: EditorState = {
  entityLogicalName: '',
  entityDisplayName: '',
  ribbonLocationLabel: '',
  model: null,
  loading: true,
  error: null,
  selection: null,
};

export type LocalAction =
  | { type: 'local/select'; selection: Selection }
  | { type: 'local/updateTab'; id: string; title: string }
  | { type: 'local/updateGroup'; id: string; title: string }
  | { type: 'local/updateControl'; id: string; patch: Partial<Pick<RibbonControl, 'label' | 'toolTipTitle' | 'toolTipDescription' | 'image16' | 'image32' | 'modernImage' | 'commandId'>> }
  | { type: 'local/updateCommand'; id: string; patch?: Partial<Pick<RibbonCommandDefinition, 'enableRules' | 'displayRules'>>; action?: RibbonAction }
  | { type: 'local/updateRule'; ruleType: 'enable' | 'display'; id: string; xml: string }
  | { type: 'local/addTab' }
  | { type: 'local/addGroup'; tabId: string }
  | { type: 'local/addControl'; tabId: string; groupId: string; kind: RibbonControl['kind'] }
  | { type: 'local/createCommandForControl'; controlId: string }
  | { type: 'local/addRuleToCommand'; commandId: string; ruleType: 'enable' | 'display' }
  | { type: 'local/removeRuleFromCommand'; commandId: string; ruleType: 'enable' | 'display'; ruleId: string }
  | { type: 'local/deleteSelected' }
  | { type: 'local/reorderControl'; groupId: string; controlId: string; beforeControlId: string | null }
  | { type: 'local/hideControl'; controlId: string }
  | { type: 'local/deleteControl'; controlId: string };

export type Action = InboundMessage | LocalAction;

export function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'ribbonLoading':
      return { ...state, loading: true, error: null };
    case 'ribbonError':
      return { ...state, loading: false, error: action.message };
    case 'ribbonModel':
      return {
        ...state,
        loading: false,
        error: null,
        entityLogicalName: action.entityLogicalName,
        entityDisplayName: action.entityDisplayName,
        ribbonLocationLabel: action.ribbonLocationLabel,
        model: action.model,
        selection: null,
      };

    case 'local/select':
      return { ...state, selection: action.selection };

    default:
      return withModel(state, action);
  }
}

function withModel(state: EditorState, action: LocalAction): EditorState {
    if (!state.model) { return state; }
    const model = structuredClone(state.model);

    switch (action.type) {
        case 'local/updateTab': {
            const tab = findTab(model, action.id);
            if (tab) { tab.title = action.title; touch(tab); }
            break;
        }
        case 'local/updateGroup': {
            const found = findGroup(model, action.id);
            if (found) { found.group.title = action.title; touch(found.group); }
            break;
        }
        case 'local/updateControl': {
            const control = findControl(model, action.id);
            if (control) { Object.assign(control, action.patch); touch(control); }
            break;
        }
        case 'local/updateCommand': {
            const command = model.commandDefinitions.find(c => c.id === action.id);
            if (command) {
                if (action.patch?.enableRules) { command.enableRules = action.patch.enableRules; }
                if (action.patch?.displayRules) { command.displayRules = action.patch.displayRules; }
                if (action.action) { command.actions = [action.action]; }
                touch(command);
            }
            break;
        }
        case 'local/updateRule': {
            const rule = (action.ruleType === 'enable' ? model.enableRules : model.displayRules).find(r => r.id === action.id);
            if (rule) { rule.xml = action.xml; touch(rule); }
            break;
        }
        case 'local/addTab': {
            const id = newId('new_tab');
            const tab: RibbonTab = { id, title: 'New Tab', groups: [], status: 'added' };
            model.tabs.push(tab);
            return { ...state, model, selection: { kind: 'tab', id } };
        }
        case 'local/addGroup': {
            const tab = findTab(model, action.tabId);
            if (!tab) { break; }
            const id = newId('new_group');
            const group: RibbonGroup = { id, title: 'New Group', controls: [], status: 'added' };
            tab.groups.push(group);
            return { ...state, model, selection: { kind: 'group', tabId: tab.id, id } };
        }
        case 'local/addControl': {
            const found = findGroup(model, action.groupId);
            if (!found) { break; }
            const id = newId('new_control');
            const control: RibbonControl = {
                kind: action.kind,
                id,
                label: `New ${action.kind}`,
                toolTipTitle: '',
                toolTipDescription: '',
                status: 'added',
                controls: action.kind === 'FlyoutAnchor' ? [{
                    kind: 'MenuSection', id: newId('new_menusection'), label: '', toolTipTitle: '', toolTipDescription: '', controls: [], status: 'added',
                }] : undefined,
            };
            found.group.controls.push(control);
            return { ...state, model, selection: { kind: 'control', tabId: found.tab.id, groupId: found.group.id, id } };
        }
        case 'local/createCommandForControl': {
            const control = findControl(model, action.controlId);
            if (!control) { break; }
            const id = newId('new_command');
            const command: RibbonCommandDefinition = { id, enableRules: [], displayRules: [], actions: [], status: 'added' };
            model.commandDefinitions.push(command);
            control.commandId = id;
            touch(control);
            break;
        }
        case 'local/addRuleToCommand': {
            const command = model.commandDefinitions.find(c => c.id === action.commandId);
            if (!command) { break; }
            const id = newId(action.ruleType === 'enable' ? 'new_enablerule' : 'new_displayrule');
            const tag = action.ruleType === 'enable' ? 'EnableRule' : 'DisplayRule';
            // Seeded as a real structured condition (Client Type: Web) rather than an empty body, so
            // RuleDialog opens straight into its structured form instead of falling back to raw XML.
            const xml = serializeRuleCondition(id, tag, defaultRuleCondition('CrmClientTypeRule'));
            const rule: RibbonRuleRaw = { id, xml, status: 'added' };
            (action.ruleType === 'enable' ? model.enableRules : model.displayRules).push(rule);
            if (action.ruleType === 'enable') { command.enableRules = [...command.enableRules, id]; }
            else { command.displayRules = [...command.displayRules, id]; }
            touch(command);
            break;
        }
        case 'local/removeRuleFromCommand': {
            const command = model.commandDefinitions.find(c => c.id === action.commandId);
            if (!command) { break; }
            if (action.ruleType === 'enable') { command.enableRules = command.enableRules.filter(id => id !== action.ruleId); }
            else { command.displayRules = command.displayRules.filter(id => id !== action.ruleId); }
            touch(command);

            // Drop the rule definition entirely once nothing references it anymore, so removing it
            // from this command doesn't leave a dangling entry that would still get exported.
            const stillReferenced = model.commandDefinitions.some(c => c.enableRules.includes(action.ruleId) || c.displayRules.includes(action.ruleId));
            if (!stillReferenced) {
                const list = action.ruleType === 'enable' ? model.enableRules : model.displayRules;
                const idx = list.findIndex(r => r.id === action.ruleId);
                if (idx !== -1) { list.splice(idx, 1); }
            }
            break;
        }
        case 'local/reorderControl': {
            const found = findGroup(model, action.groupId);
            if (!found) { break; }
            const arr = found.group.controls;
            const control = arr.find(c => c.id === action.controlId);
            if (!control || action.controlId === action.beforeControlId) { break; }

            const rest = arr.filter(c => c.id !== action.controlId);
            const insertIndex = action.beforeControlId ? rest.findIndex(c => c.id === action.beforeControlId) : -1;
            const reordered = insertIndex === -1
                ? [...rest, control]
                : [...rest.slice(0, insertIndex), control, ...rest.slice(insertIndex)];
            if (reordered.every((c, i) => c === arr[i])) { break; } // dropped back where it started

            touch(control);
            found.group.controls = reordered;
            break;
        }
        case 'local/deleteSelected': {
            const sel = state.selection;
            if (!sel) { break; }
            deleteSelection(model, sel);
            return { ...state, model, selection: null };
        }
        case 'local/hideControl': {
            hideControl(model, action.controlId);
            break;
        }
        case 'local/deleteControl': {
            deleteControl(model, action.controlId);
            break;
        }
        default:
            break;
    }

    return { ...state, model };
}

function deleteSelection(model: RibbonModel, sel: NonNullable<Selection>): void {
    if (sel.kind === 'tab') {
        const tab = findTab(model, sel.id);
        if (!tab) { return; }
        if (tab.status === 'added') { model.tabs = model.tabs.filter(t => t.id !== sel.id); }
        else { tab.status = tab.status === 'deleted' ? 'unchanged' : 'deleted'; }
    } else if (sel.kind === 'group') {
        const found = findGroup(model, sel.id);
        if (!found) { return; }
        if (found.group.status === 'added') { found.tab.groups = found.tab.groups.filter(g => g.id !== sel.id); }
        else { found.group.status = found.group.status === 'deleted' ? 'unchanged' : 'deleted'; }
    } else if (sel.kind === 'control') {
        // The toolbar's single "Delete / Restore" button acts on whatever's selected without
        // distinguishing why -- unlike the button tile's right-click menu (hideControl/deleteControl
        // below), which offers them as two separate, individually-disabled actions since only one is
        // ever actually valid for a given control (see those functions' own comments).
        const control = findControl(model, sel.id);
        if (!control) { return; }
        if (control.status === 'added') { deleteControl(model, sel.id); }
        else { hideControl(model, sel.id); }
    }
}

// Toggles a built-in/existing control's visibility (unchanged <-> deleted, i.e. hidden via a
// HideCustomAction on export -- see buildRibbonDiffXml) -- a no-op for a control added this
// session, since there's no real server-side element yet to hide; the only valid action there is
// deleteControl below.
function hideControl(model: RibbonModel, controlId: string): void {
    const control = findControl(model, controlId);
    if (!control || control.status === 'added') { return; }
    control.status = control.status === 'deleted' ? 'unchanged' : 'deleted';
}

// Removes a control added this session entirely -- a no-op for a pre-existing/built-in control,
// which can only ever be hidden (see hideControl above), never truly deleted.
function deleteControl(model: RibbonModel, controlId: string): void {
    const control = findControl(model, controlId);
    if (!control || control.status !== 'added') { return; }
    const parentArray = findControlParentArray(model, controlId);
    if (parentArray) { removeFromArray(parentArray, controlId); }
}

function removeFromArray(controls: RibbonControl[], id: string): void {
    const idx = controls.findIndex(c => c.id === id);
    if (idx !== -1) { controls.splice(idx, 1); }
}

function touch(node: { status: RibbonTab['status'] }): void {
    if (node.status === 'unchanged') { node.status = 'modified'; }
}

// ── Tree lookups ──────────────────────────────────────────────────────────────

export function findTab(model: RibbonModel, id: string): RibbonTab | undefined {
    return model.tabs.find(t => t.id === id);
}

export function findGroup(model: RibbonModel, id: string): { tab: RibbonTab; group: RibbonGroup } | undefined {
    for (const tab of model.tabs) {
        const group = tab.groups.find(g => g.id === id);
        if (group) { return { tab, group }; }
    }
    return undefined;
}

export function findControl(model: RibbonModel, id: string): RibbonControl | undefined {
    function search(controls: RibbonControl[]): RibbonControl | undefined {
        for (const c of controls) {
            if (c.id === id) { return c; }
            if (c.controls) { const found = search(c.controls); if (found) { return found; } }
        }
        return undefined;
    }
    for (const tab of model.tabs) {
        for (const group of tab.groups) {
            const found = search(group.controls);
            if (found) { return found; }
        }
    }
    return undefined;
}

function findControlParentArray(model: RibbonModel, id: string): RibbonControl[] | undefined {
    function search(controls: RibbonControl[]): RibbonControl[] | undefined {
        if (controls.some(c => c.id === id)) { return controls; }
        for (const c of controls) {
            if (c.controls) { const found = search(c.controls); if (found) { return found; } }
        }
        return undefined;
    }
    for (const tab of model.tabs) {
        for (const group of tab.groups) {
            const found = search(group.controls);
            if (found) { return found; }
        }
    }
    return undefined;
}

export function selectionTabId(selection: Selection): string | undefined {
    if (!selection) { return undefined; }
    if (selection.kind === 'tab') { return selection.id; }
    if (selection.kind === 'group' || selection.kind === 'control') { return selection.tabId; }
    return undefined;
}

export function selectionGroupId(selection: Selection): string | undefined {
    if (!selection) { return undefined; }
    if (selection.kind === 'group') { return selection.id; }
    if (selection.kind === 'control') { return selection.groupId; }
    return undefined;
}

let idCounter = 0;
function newId(prefix: string): string {
    idCounter += 1;
    return `${prefix}.${Date.now().toString(36)}${idCounter}`;
}
