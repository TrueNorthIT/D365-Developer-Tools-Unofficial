import { useEffect, useReducer, useState } from 'react';
import type { InboundMessage } from '../protocol';
import { initialState, reducer, type Location } from '../ribbonState';
import { post } from '../vscodeApi';
import { Toolbar } from './Toolbar';
import { RibbonPreview, distinctLocations } from './RibbonPreview';
import { NodeEditor } from './NodeEditor';

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Pure navigation state (which tab/location is showing) — not part of the edit-tracked model, so
  // it doesn't need to survive export/round-trip and isn't reset by every model edit.
  const [location, setLocation] = useState<Location | 'All'>('All');
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);

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
        onAddTab={() => dispatch({ type: 'local/addTab' })}
        onAddGroup={tabId => dispatch({ type: 'local/addGroup', tabId })}
        onAddControl={(tabId, groupId, kind) => dispatch({ type: 'local/addControl', tabId, groupId, kind })}
        onDelete={() => dispatch({ type: 'local/deleteSelected' })}
        onReload={() => post({ type: 'reloadFromServer' })}
        onExport={() => post({ type: 'exportRibbonDiffXml', model })}
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
        />
        <NodeEditor model={model} selection={state.selection} dispatch={dispatch} />
      </div>
    </div>
  );
}
