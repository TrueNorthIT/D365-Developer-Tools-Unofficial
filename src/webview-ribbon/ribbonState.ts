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
  /** Workspace-configured Dataverse publisher prefix -- see buildRibbonElementId below. Empty if the
   *  user hasn't set one yet (ribbonEditorPanel.ts prompts for it before the ribbon loads). */
  publisherPrefix: string;
  model: RibbonModel | null;
  loading: boolean;
  error: string | null;
  selection: Selection;
}

export const initialState: EditorState = {
  entityLogicalName: '',
  entityDisplayName: '',
  ribbonLocationLabel: '',
  publisherPrefix: '',
  model: null,
  loading: true,
  error: null,
  selection: null,
};

// What's currently being named via NamePromptDialog (App.tsx) -- distinct from Selection, which
// tracks an EXISTING node; this tracks the not-yet-created one a right-click/toolbar "+" action is
// in the middle of adding. Pure UI-flow state, not part of the edit-tracked model.
export type PromptRequest =
  | { kind: 'tab' }
  | { kind: 'group'; tabId: string }
  | { kind: 'control'; tabId: string; groupId: string; controlKind: RibbonControl['kind'] }
  | { kind: 'command'; controlId: string }
  | { kind: 'rule'; commandId: string; ruleType: 'enable' | 'display' };

export function kindSuffixFor(request: PromptRequest): string {
  switch (request.kind) {
    case 'tab': return 'tab';
    case 'group': return 'group';
    case 'control': return request.controlKind.toLowerCase();
    case 'command': return 'command';
    case 'rule': return request.ruleType === 'enable' ? 'enablerule' : 'displayrule';
  }
}

// Ribbon element ids can't contain whitespace or most punctuation -- this keeps letters, digits, and
// underscores (Dataverse schema/logical names commonly use underscores) and drops everything else,
// including the input entirely once lowercased, so casing differences alone can't produce two
// "different" ids that collide once actually imported.
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
}

// {publisherPrefix}.{entityLogicalName}.{name}.{kind} -- e.g. "new.account.myaction.button" -- the
// same shape any other unmanaged customization's id would take, rather than this tool's own
// throwaway "new_"-style ids (see the removed newId helper this replaced). publisherPrefix comes
// from a workspace setting (ribbonEditorPanel.ts prompts for it once); entityLogicalName is this
// ribbon's own entity; name is whatever the user typed into NamePromptDialog.
export function buildRibbonElementId(publisherPrefix: string, entityLogicalName: string, name: string, kindSuffix: string): string {
  return `${publisherPrefix}.${entityLogicalName}.${slugify(name)}.${kindSuffix}`;
}

// Tries `base`, then `base2`, `base3`, ... until one `isTaken` says isn't -- used to default a
// child/sibling element's name to match its parent/source without silently colliding with something
// that already has that exact name (NamePromptDialog's menu section field, App.tsx's command/rule
// defaults below).
export function firstUnusedName(base: string, isTaken: (candidate: string) => boolean): string {
  if (!base || !isTaken(base)) { return base; }
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!isTaken(candidate)) { return candidate; }
  }
}

// Recovers the {name} segment from an id this editor itself built as
// {publisherPrefix}.{entityLogicalName}.{name}.{kindSuffix} (see buildRibbonElementId) -- returns
// undefined if `id` doesn't actually match that shape (base ribbon, or a customization made before
// a prefix was configured/by another tool), since there's no sensible name to default to then.
// Used to default a command's name to its control's, and a rule's name to its command's -- both
// created in a separate step/prompt from their parent, unlike a control's own menu section (created
// in the very same prompt, so it can just reuse the live `name` state directly instead).
export function extractNameSegment(id: string, publisherPrefix: string, entityLogicalName: string, kindSuffix: string): string | undefined {
  if (!publisherPrefix) { return undefined; }
  const prefix = `${publisherPrefix}.${entityLogicalName}.`;
  const suffix = `.${kindSuffix}`;
  if (!id.startsWith(prefix) || !id.endsWith(suffix) || id.length <= prefix.length + suffix.length) { return undefined; }
  return id.slice(prefix.length, id.length - suffix.length);
}

// Every id currently in the model, at any depth -- used to validate a new name won't collide with
// something that already exists (NamePromptDialog, via App.tsx).
export function collectAllIds(model: RibbonModel): Set<string> {
  const ids = new Set<string>();
  const walkControls = (controls: RibbonControl[]): void => {
    for (const c of controls) {
      ids.add(c.id);
      if (c.controls) { walkControls(c.controls); }
    }
  };
  for (const tab of model.tabs) {
    ids.add(tab.id);
    for (const group of tab.groups) {
      ids.add(group.id);
      walkControls(group.controls);
    }
  }
  for (const cmd of model.commandDefinitions) { ids.add(cmd.id); }
  for (const rule of model.enableRules) { ids.add(rule.id); }
  for (const rule of model.displayRules) { ids.add(rule.id); }
  return ids;
}

export type LocalAction =
  | { type: 'local/select'; selection: Selection }
  | { type: 'local/updateTab'; id: string; title: string }
  | { type: 'local/updateGroup'; id: string; title: string }
  | { type: 'local/updateControl'; id: string; patch: Partial<Pick<RibbonControl, 'label' | 'toolTipTitle' | 'toolTipDescription' | 'image16' | 'image32' | 'modernImage' | 'commandId'>> }
  | { type: 'local/updateCommand'; id: string; patch?: Partial<Pick<RibbonCommandDefinition, 'enableRules' | 'displayRules'>>; action?: RibbonAction }
  | { type: 'local/updateRule'; ruleType: 'enable' | 'display'; id: string; xml: string }
  | { type: 'local/addTab'; id: string; title: string }
  | { type: 'local/addGroup'; tabId: string; id: string; title: string }
  | { type: 'local/addControl'; tabId: string; groupId: string; kind: RibbonControl['kind']; id: string; title: string; menuSectionId?: string; commandId?: string }
  | { type: 'local/createCommandForControl'; controlId: string; id: string }
  | { type: 'local/addRuleToCommand'; commandId: string; ruleType: 'enable' | 'display'; id: string }
  | { type: 'local/removeRuleFromCommand'; commandId: string; ruleType: 'enable' | 'display'; ruleId: string }
  | { type: 'local/deleteSelected' }
  | { type: 'local/reorderControl'; groupId: string; controlId: string; beforeControlId: string | null }
  | { type: 'local/deleteControl'; controlId: string }
  | { type: 'local/removeCustomization'; controlId: string };

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
        publisherPrefix: action.publisherPrefix,
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
            const tab: RibbonTab = { id: action.id, title: action.title, groups: [], status: 'added' };
            model.tabs.push(tab);
            return { ...state, model, selection: { kind: 'tab', id: action.id } };
        }
        case 'local/addGroup': {
            const tab = findTab(model, action.tabId);
            if (!tab) { break; }
            const group: RibbonGroup = { id: action.id, title: action.title, controls: [], status: 'added' };
            tab.groups.push(group);
            return { ...state, model, selection: { kind: 'group', tabId: tab.id, id: action.id } };
        }
        case 'local/addControl': {
            const found = findGroup(model, action.groupId);
            if (!found) { break; }
            const control: RibbonControl = {
                kind: action.kind,
                id: action.id,
                label: action.title,
                toolTipTitle: '',
                toolTipDescription: '',
                status: 'added',
                commandId: action.commandId,
                controls: action.kind === 'FlyoutAnchor' ? [{
                    kind: 'MenuSection', id: action.menuSectionId!, label: '', toolTipTitle: '', toolTipDescription: '', controls: [], status: 'added',
                }] : undefined,
            };
            // A Button/SplitButton is created with its own command already attached (see App.tsx's
            // submitPrompt) -- FlyoutAnchor is deliberately excluded, since it opens a menu rather than
            // invoking a command itself; its children are what actually need commands.
            if (action.commandId) {
                model.commandDefinitions.push({ id: action.commandId, enableRules: [], displayRules: [], actions: [], status: 'added' });
            }
            found.group.controls.push(control);
            return { ...state, model, selection: { kind: 'control', tabId: found.tab.id, groupId: found.group.id, id: action.id } };
        }
        case 'local/createCommandForControl': {
            const control = findControl(model, action.controlId);
            if (!control) { break; }
            const id = action.id;
            const command: RibbonCommandDefinition = { id, enableRules: [], displayRules: [], actions: [], status: 'added' };
            model.commandDefinitions.push(command);
            control.commandId = id;
            touch(control);
            break;
        }
        case 'local/addRuleToCommand': {
            const command = model.commandDefinitions.find(c => c.id === action.commandId);
            if (!command) { break; }
            const id = action.id;
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

            // Only the MOVED control needs a new Sequence to reflect its new position -- this used to
            // touch() and renumber every control in the group, which marks every untouched sibling
            // 'modified' too, forcing each one to be re-emitted as its own CustomAction on export --
            // not just wasteful, but actively dangerous: confirmed against a real org, a plain
            // drag-and-drop reorder (nothing to do with the sibling at all) marked the base ribbon's
            // Mscrm.SubGrid.*.ChangeDataSetControlButton FlyoutAnchor 'modified' purely by sharing a
            // group with the control actually being moved -- and re-emitting it (a deprecated,
            // Microsoft-acknowledged "not supported to modify" element that's already missing a
            // Menu/PopulateQueryCommand in the base ribbon) broke publishing outright. Giving the moved
            // control a Sequence that simply falls between its new neighbors' EXISTING Sequence values
            // repositions it without touching anything else in the group at all.
            const newIndex = reordered.indexOf(control);
            const prevSeq = newIndex > 0 ? sequenceNumberOf(reordered[newIndex - 1]) : undefined;
            const nextSeq = newIndex < reordered.length - 1 ? sequenceNumberOf(reordered[newIndex + 1]) : undefined;
            control.sequence = String(sequenceBetween(prevSeq, nextSeq));
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
        case 'local/deleteControl': {
            deleteOrHideControl(model, action.controlId);
            break;
        }
        case 'local/removeCustomization': {
            removeCustomization(model, action.controlId);
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
        deleteOrHideControl(model, sel.id);
    }
}

// A control's only ever valid removal action depends entirely on whether it was added this session:
// one added this session has no real server-side element yet, so it's just removed from the tree
// (deleteControl); anything else -- base ribbon or a prior customization, indistinguishable at this
// point (see mergeRibbonDiffXml in ribbonXmlBuilder.ts) -- can only be marked 'deleted' here and
// resolved at publish time, which turns out to be a true removal when it *was* a customization, or a
// HideCustomAction otherwise (hideControl). Exposed as one action (not two) so neither the toolbar's
// "Delete / Restore" button nor the per-control context menu's single "Delete"/"Restore" item ever
// needs to know or guess which case applies -- it's always the right one.
function deleteOrHideControl(model: RibbonModel, controlId: string): void {
    const control = findControl(model, controlId);
    if (!control) { return; }
    if (control.status === 'added') { deleteControl(model, controlId); }
    else { hideControl(model, controlId); }
}

// Toggles a built-in/existing control's visibility (unchanged <-> deleted, i.e. hidden via a
// HideCustomAction on export -- see buildRibbonDiffXml) -- only called for a control that isn't
// 'added' this session (see deleteOrHideControl above).
function hideControl(model: RibbonModel, controlId: string): void {
    const control = findControl(model, controlId);
    if (!control) { return; }
    control.status = control.status === 'deleted' ? 'unchanged' : 'deleted';
}

// Toggles 'reverted' <-> 'unchanged' -- see RibbonControl.status's own doc comment for exactly what
// 'reverted' means and why it's offered as a separate action from hideControl/deleteOrHideControl,
// rather than folded into the same "Delete" toggle. No-op for a control added this session (status
// 'added'): there's no existing server-side customization to revert in the first place.
function removeCustomization(model: RibbonModel, controlId: string): void {
    const control = findControl(model, controlId);
    if (!control || control.status === 'added') { return; }
    control.status = control.status === 'reverted' ? 'unchanged' : 'reverted';
}

// Removes a control added this session entirely -- only called for a control that IS 'added' this
// session (see deleteOrHideControl above).
function deleteControl(model: RibbonModel, controlId: string): void {
    const control = findControl(model, controlId);
    if (!control) { return; }
    const parentArray = findControlParentArray(model, controlId);
    if (parentArray) { removeFromArray(parentArray, controlId); }

    // A Button/SplitButton created via addControl brings its own freshly-created CommandDefinition
    // with it (see 'local/addControl') -- deleting the control again before ever publishing it
    // otherwise leaves that CommandDefinition behind with nothing pointing at it: it's still
    // 'unchanged'/'added' isn't tracked per-control, so buildRibbonDiffFragments has no way to know
    // it's now orphaned, and it publishes as dead weight forever (confirmed against a live org where
    // exactly this happened -- the button was gone, but its CommandDefinition remained, unreferenced,
    // in every subsequent publish). Only ever drops a command that was ALSO added this session --
    // one that already existed on the server is left alone, same as this tool leaves any other
    // already-published customization alone once its owning control is just hidden (hideControl)
    // rather than removed outright.
    if (control.commandId && !anyControlReferencesCommand(model, control.commandId)) {
        const cmdIndex = model.commandDefinitions.findIndex(c => c.id === control.commandId);
        if (cmdIndex !== -1 && model.commandDefinitions[cmdIndex].status === 'added') {
            model.commandDefinitions.splice(cmdIndex, 1);
        }
    }
}

function anyControlReferencesCommand(model: RibbonModel, commandId: string): boolean {
    const walk = (controls: RibbonControl[]): boolean =>
        controls.some(c => c.commandId === commandId || (c.controls ? walk(c.controls) : false));
    return model.tabs.some(tab => tab.groups.some(group => walk(group.controls)));
}

function removeFromArray(controls: RibbonControl[], id: string): void {
    const idx = controls.findIndex(c => c.id === id);
    if (idx !== -1) { controls.splice(idx, 1); }
}

function touch(node: { status: RibbonTab['status'] }): void {
    if (node.status === 'unchanged') { node.status = 'modified'; }
}

function sequenceNumberOf(control: RibbonControl): number | undefined {
    return control.sequence !== undefined ? Number(control.sequence) : undefined;
}

// Picks a Sequence strictly between two neighbors' existing values wherever there's room, falling
// back to a fixed offset from whichever neighbor exists when the other side is the start/end of the
// group -- see reorderControl's own doc comment for why this must never touch a neighbor's own
// Sequence to make room.
function sequenceBetween(prev: number | undefined, next: number | undefined): number {
    if (prev === undefined && next === undefined) { return 100; }
    if (prev === undefined) { return next! - 10; }
    if (next === undefined) { return prev + 10; }
    const mid = Math.floor((prev + next) / 2);
    return mid > prev ? mid : prev + 1;
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

