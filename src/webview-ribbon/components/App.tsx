import { useEffect, useReducer, useState } from 'react';
import type { InboundMessage } from '../protocol';
import { buildRibbonElementId, collectAllIds, initialState, kindSuffixFor, reducer, type Location, type PromptRequest } from '../ribbonState';
import { post } from '../vscodeApi';
import { Toolbar } from './Toolbar';
import { RibbonPreview, distinctLocations } from './RibbonPreview';
import { NodeEditor } from './NodeEditor';
import { NamePromptDialog } from './NamePromptDialog';

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Pure navigation state (which tab/location is showing) — not part of the edit-tracked model, so
  // it doesn't need to survive export/round-trip and isn't reset by every model edit.
  const [location, setLocation] = useState<Location | 'All'>('All');
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
  // What NamePromptDialog is currently naming, if anything -- see PromptRequest in ribbonState.ts.
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

  const requestPrompt = (request: PromptRequest): void => setPrompt(request);

  const submitPrompt = (name: string, menuSectionName?: string): void => {
    if (!prompt) { return; }
    const id = buildRibbonElementId(state.publisherPrefix, state.entityLogicalName, name, kindSuffixFor(prompt));
    switch (prompt.kind) {
      case 'tab':
        dispatch({ type: 'local/addTab', id, title: name });
        break;
      case 'group':
        dispatch({ type: 'local/addGroup', tabId: prompt.tabId, id, title: name });
        break;
      case 'control': {
        const menuSectionId = menuSectionName ? buildRibbonElementId(state.publisherPrefix, state.entityLogicalName, menuSectionName, 'menusection') : undefined;
        dispatch({ type: 'local/addControl', tabId: prompt.tabId, groupId: prompt.groupId, kind: prompt.controlKind, id, title: name, menuSectionId });
        break;
      }
      case 'command':
        dispatch({ type: 'local/createCommandForControl', controlId: prompt.controlId, id });
        break;
      case 'rule':
        dispatch({ type: 'local/addRuleToCommand', commandId: prompt.commandId, ruleType: prompt.ruleType, id });
        break;
    }
    setPrompt(null);
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
          title={promptTitle(prompt)}
          request={prompt}
          publisherPrefix={state.publisherPrefix}
          entityLogicalName={state.entityLogicalName}
          existingIds={collectAllIds(model)}
          onSubmit={submitPrompt}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  );
}

function promptTitle(request: PromptRequest): string {
  switch (request.kind) {
    case 'tab': return 'New Tab';
    case 'group': return 'New Group';
    case 'control': return `New ${request.controlKind}`;
    case 'command': return 'New Command';
    case 'rule': return request.ruleType === 'enable' ? 'New Enable Rule' : 'New Display Rule';
  }
}
