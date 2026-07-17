import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EntityInfo, InboundMessage } from '../protocol';
import { post } from '../vscodeApi';

// This hook owns the genuinely event-shaped state pushed by the extension (connection,
// entity list, solution filter) plus local expand/collapse UI state. Pull-shaped per-key
// data (attributes, icons) lives in TanStack Query — see queries.ts.

export interface SolutionFilter {
  name: string;
  entityIds: Set<string>;
}

export interface ExtensionState {
  connected: boolean;
  restoring: boolean;
  entitiesLoading: boolean;
  // A cached entity list is already showing and a background refetch is in flight -- distinct from
  // entitiesLoading, which blanks the list; this just drives a small non-blocking indicator.
  entitiesRefreshing: boolean;
  entities: EntityInfo[];
  entitiesError: string | null;
  expanded: Set<string>;
  solutionFilter: SolutionFilter | null;
}

const initialState: ExtensionState = {
  connected: false,
  restoring: false,
  entitiesLoading: false,
  entitiesRefreshing: false,
  entities: [],
  entitiesError: null,
  expanded: new Set(),
  solutionFilter: null,
};

type Action =
  | InboundMessage
  | { type: 'local/expand'; logicalName: string }
  | { type: 'local/collapse'; logicalName: string }
  | { type: 'local/clearSolution' };

function reducer(state: ExtensionState, action: Action): ExtensionState {
  switch (action.type) {
    case 'connectionState':
      return { ...state, connected: action.connected, restoring: action.restoring };

    case 'entitiesLoading':
      return { ...state, entitiesLoading: true, entitiesRefreshing: false, entitiesError: null };

    case 'entities':
      // Fresh entity set (new environment / refresh): collapse everything.
      return {
        ...state,
        entities: action.data,
        entitiesLoading: false,
        entitiesError: null,
        expanded: new Set(),
      };

    case 'entitiesError':
      return { ...state, entitiesLoading: false, entitiesRefreshing: false, entitiesError: action.message };

    case 'entitiesRefreshing':
      return { ...state, entitiesRefreshing: true };

    case 'entitiesRefreshed':
      // Unlike 'entities', preserve expand/collapse -- the user may already be interacting with the
      // tree the cached 'entities' message rendered while this background refetch was in flight.
      return { ...state, entities: action.data, entitiesRefreshing: false, entitiesError: null };

    case 'solutionFilter':
      return { ...state, solutionFilter: { name: action.name, entityIds: new Set(action.entityIds) } };

    case 'local/clearSolution':
      return { ...state, solutionFilter: null };

    case 'local/expand': {
      const expanded = new Set(state.expanded);
      expanded.add(action.logicalName);
      return { ...state, expanded };
    }

    case 'local/collapse': {
      const expanded = new Set(state.expanded);
      expanded.delete(action.logicalName);
      return { ...state, expanded };
    }

    default:
      return state;
  }
}

export interface ExtensionApi {
  state: ExtensionState;
  connect(): void;
  toggleEntity(logicalName: string): void;
  showSolutionPicker(): void;
  clearSolutionFilter(): void;
  makeInterface(entityLogicalName: string, entityDisplayName: string): void;
  makeEnum(
    entityLogicalName: string,
    attributeLogicalName: string,
    attributeDisplayName: string,
    attributeType: string,
  ): void;
}

export function useExtensionState(): ExtensionApi {
  const [state, dispatch] = useReducer(reducer, initialState);
  const queryClient = useQueryClient();
  // Always-current mirror of state so stable callbacks can read the latest without re-binding.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onMessage = (e: MessageEvent<InboundMessage>) => {
      const m = e.data;
      if (!m || typeof (m as { type?: unknown }).type !== 'string') { return; }
      dispatch(m);
      // A new entity set means a new/refreshed environment — drop cached schema so it refetches.
      if (m.type === 'entities') {
        queryClient.removeQueries({ queryKey: ['attributes'] });
        queryClient.removeQueries({ queryKey: ['icon'] });
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [queryClient]);

  const connect = useCallback(() => post({ type: 'connect' }), []);
  const showSolutionPicker = useCallback(() => post({ type: 'showSolutionPicker' }), []);
  const clearSolutionFilter = useCallback(() => {
    dispatch({ type: 'local/clearSolution' });
    post({ type: 'clearSolutionFilter' });
  }, []);

  const toggleEntity = useCallback((logicalName: string) => {
    const expanded = stateRef.current.expanded.has(logicalName);
    dispatch({ type: expanded ? 'local/collapse' : 'local/expand', logicalName });
  }, []);

  const makeInterface = useCallback((entityLogicalName: string, entityDisplayName: string) => {
    post({ type: 'makeInterface', entityLogicalName, entityDisplayName });
  }, []);

  const makeEnum = useCallback(
    (entityLogicalName: string, attributeLogicalName: string, attributeDisplayName: string, attributeType: string) => {
      post({ type: 'makeEnum', entityLogicalName, attributeLogicalName, attributeDisplayName, attributeType });
    },
    [],
  );

  return { state, connect, toggleEntity, showSolutionPicker, clearSolutionFilter, makeInterface, makeEnum };
}
