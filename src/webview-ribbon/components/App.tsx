import { useEffect, useReducer, useState } from 'react';
import type { InboundMessage } from '../protocol';
import {
  buildRibbonElementId, collectAllIds, extractNameSegment, findControl, firstUnusedName, initialState, kindSuffixFor, reducer,
  type Location, type PromptRequest,
} from '../ribbonState';
import { post } from '../vscodeApi';
import { Toolbar } from './Toolbar';
import { RibbonPreview, distinctLocations } from './RibbonPreview';
import { NodeEditor } from './NodeEditor';
import { NamePromptDialog } from './NamePromptDialog';

const PROMPT_TITLES: Record<PromptRequest['kind'], string> = {
  tab: 'New Tab',
  group: 'New Group',
  control: 'New Control',
  command: 'New Command',
  rule: 'New Rule',
};

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Pure navigation state (which tab/location is showing) — not part of the edit-tracked model, so
  // it doesn't need to survive export/round-trip and isn't reset by every model edit.
  const [location, setLocation] = useState<Location | 'All'>('All');
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
  // What's currently being named, if anything -- see PromptRequest's own doc comment.
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent<InboundMessage>) => {
      const m = e.data;
      if (!m || typeof (m as { type?: unknown }).type !== 'string') { return; }
      dispatch(m);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (state.loading) {
    return <div id="ribbon-loading"><span className="spinner" /> Loading ribbon…</div>;
  }
  if (state.error) {
    return <div className="message error">Failed to load ribbon: {state.error}</div>;
  }
  if (!state.model) {
    return null;
  }

  const model = state.model;
  const existingIds = collectAllIds(model);

  const isTaken = (kindSuffix: string) => (candidate: string) =>
    existingIds.has(buildRibbonElementId(state.publisherPrefix, state.entityLogicalName, candidate, kindSuffix));

  // A command defaults to its control's own name; a rule defaults to its command's -- both created
  // in a separate step/prompt from their parent (unlike a control's menu section, created in the
  // very same prompt -- see NamePromptDialog's own default for that one). undefined when there's
  // nothing sensible to default to (no publisher prefix, or the parent's id doesn't match this
  // editor's own {prefix}.{entity}.{name}.{kind} shape -- e.g. base ribbon).
  const defaultNameFor = (request: PromptRequest): string | undefined => {
    if (request.kind === 'command') {
      const control = findControl(model, request.controlId);
      const base = control && extractNameSegment(control.id, state.publisherPrefix, state.entityLogicalName, control.kind.toLowerCase());
      return base ? firstUnusedName(base, isTaken('command')) : undefined;
    }
    if (request.kind === 'rule') {
      const command = model.commandDefinitions.find(c => c.id === request.commandId);
      const base = command && extractNameSegment(command.id, state.publisherPrefix, state.entityLogicalName, 'command');
      return base ? firstUnusedName(base, isTaken(request.ruleType === 'enable' ? 'enablerule' : 'displayrule')) : undefined;
    }
    return undefined;
  };

  const submitPrompt = (request: PromptRequest, name: string, menuSectionName?: string): void => {
    const id = buildRibbonElementId(state.publisherPrefix, state.entityLogicalName, name, kindSuffixFor(request));
    switch (request.kind) {
      case 'tab':
        dispatch({ type: 'local/addTab', id, title: name });
        break;
      case 'group':
        dispatch({ type: 'local/addGroup', tabId: request.tabId, id, title: name });
        break;
      case 'control': {
        const menuSectionId = request.controlKind === 'FlyoutAnchor' && menuSectionName
          ? buildRibbonElementId(state.publisherPrefix, state.entityLogicalName, menuSectionName, 'menusection')
          : undefined;
        // A Button/SplitButton gets its own command automatically, named to match -- see
        // NamePromptDialog's "A command will be created automatically" note for this same control kind.
        const commandId = request.controlKind === 'Button' || request.controlKind === 'SplitButton'
          ? buildRibbonElementId(state.publisherPrefix, state.entityLogicalName, firstUnusedName(name, isTaken('command')), 'command')
          : undefined;
        dispatch({ type: 'local/addControl', tabId: request.tabId, groupId: request.groupId, kind: request.controlKind, id, title: name, menuSectionId, commandId });
        break;
      }
      case 'command':
        dispatch({ type: 'local/createCommandForControl', controlId: request.controlId, id });
        break;
      case 'rule':
        dispatch({ type: 'local/addRuleToCommand', commandId: request.commandId, ruleType: request.ruleType, id });
        break;
    }
  };

  // Shared by every "+" action (toolbar, right-click, and NodeEditor's Create Command/+ New rule) --
  // see PromptRequest's own doc comment for why naming happens before creating anything now. A rule
  // is the one case with a name ALWAYS confidently derivable from something the user already named
  // themselves (its owning command) and no meaningful reason to review/edit it first -- unlike a
  // command (may attach to a pre-existing control this tool never named) or a brand-new
  // tab/group/control (nothing to derive a name from at all) -- so it skips the dialog entirely and
  // creates straight away, falling back to prompting only if a default genuinely can't be derived
  // (e.g. the owning command's id doesn't match this editor's own naming scheme).
  const requestPrompt = (request: PromptRequest): void => {
    if (request.kind === 'rule') {
      const defaultName = defaultNameFor(request);
      if (defaultName) {
        submitPrompt(request, defaultName);
        return;
      }
    }
    setPrompt(request);
  };

  return (
    <div id="ribbon-main">
      <Toolbar
        entityDisplayName={state.entityDisplayName}
        entityLogicalName={state.entityLogicalName}
        ribbonLocationLabel={state.ribbonLocationLabel}
        selection={state.selection}
        location={location}
        availableLocations={distinctLocations(model.tabs)}
        onLocationChange={setLocation}
        onAddTab={() => requestPrompt({ kind: 'tab' })}
        onAddGroup={tabId => requestPrompt({ kind: 'group', tabId })}
        onAddControl={(tabId, groupId, kind) => requestPrompt({ kind: 'control', tabId, groupId, controlKind: kind })}
        onDelete={() => dispatch({ type: 'local/deleteSelected' })}
        onReload={() => post({ type: 'reloadFromServer' })}
        onExport={() => post({ type: 'exportRibbonDiffXml', model })}
        onPublish={() => post({ type: 'publishToDynamics', model })}
        onRegenerateRibbonMetadata={() => post({ type: 'regenerateRibbonMetadata' })}
      />
      <div id="ribbon-body">
        <RibbonPreview
          model={model}
          location={location}
          activeTabId={activeTabId}
          onActiveTabChange={setActiveTabId}
          selection={state.selection}
          onSelect={selection => dispatch({ type: 'local/select', selection })}
          onReorderControl={(groupId, controlId, beforeControlId) => dispatch({ type: 'local/reorderControl', groupId, controlId, beforeControlId })}
          onDeleteControl={controlId => dispatch({ type: 'local/deleteControl', controlId })}
          onRequestPrompt={requestPrompt}
        />
        <NodeEditor model={model} selection={state.selection} dispatch={dispatch} onRequestPrompt={requestPrompt} />
      </div>

      {prompt && (
        <NamePromptDialog
          title={PROMPT_TITLES[prompt.kind]}
          request={prompt}
          publisherPrefix={state.publisherPrefix}
          entityLogicalName={state.entityLogicalName}
          existingIds={existingIds}
          initialName={defaultNameFor(prompt)}
          onSubmit={(name, menuSectionName) => { submitPrompt(prompt, name, menuSectionName); setPrompt(null); }}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  );
}
