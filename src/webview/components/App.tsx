import { useMemo, useState } from 'react';
import { useExtensionState } from '../hooks/useExtensionState';
import { Spinner } from './Spinner';
import { Toolbar } from './Toolbar';
import { EntityList } from './EntityList';
import { ContextMenu, type ContextTarget } from './ContextMenu';

interface CtxState {
  target: ContextTarget;
  x: number;
  y: number;
}

export function App() {
  const api = useExtensionState();
  const { state } = api;
  const [search, setSearch] = useState('');
  const [ctx, setCtx] = useState<CtxState | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let result = state.entities;
    if (term) {
      result = result.filter(
        e => e.logicalName.indexOf(term) !== -1 || (e.displayName || '').toLowerCase().indexOf(term) !== -1,
      );
    }
    if (state.solutionFilter) {
      const ids = state.solutionFilter.entityIds;
      result = result.filter(e => ids.has(e.metadataId));
    }
    return result;
  }, [state.entities, state.solutionFilter, search]);

  if (state.restoring) {
    return <div id="restoring"><Spinner /> Connecting…</div>;
  }

  if (!state.connected) {
    return (
      <div id="disconnected">
        <p>Connect to a D365 environment to browse entities.</p>
        <button type="button" id="connect-btn" onClick={api.connect}>Connect</button>
      </div>
    );
  }

  return (
    <div id="main">
      <Toolbar
        search={search}
        onSearchChange={setSearch}
        solutionFilter={state.solutionFilter}
        onPickSolution={api.showSolutionPicker}
        onClearSolution={api.clearSolutionFilter}
        refreshing={state.entitiesRefreshing}
      />
      <EntityList
        state={state}
        entities={filtered}
        onToggle={api.toggleEntity}
        onOpenContextMenu={(target, x, y) => setCtx({ target, x, y })}
      />
      {ctx && (
        <ContextMenu
          target={ctx.target}
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onMakeInterface={api.makeInterface}
          onMakeEnum={api.makeEnum}
        />
      )}
    </div>
  );
}
