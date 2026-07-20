import type { SolutionFilter } from '../hooks/useExtensionState';
import { Spinner } from './Spinner';

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  solutionFilter: SolutionFilter | null;
  onPickSolution: () => void;
  onClearSolution: () => void;
  refreshing: boolean;
}

export function Toolbar({ search, onSearchChange, solutionFilter, onPickSolution, onClearSolution, refreshing }: Props) {
  return (
    <div className="toolbar">
      <div className="search-wrap">
        <span className="search-icon">⌕</span>
        <input
          type="text"
          placeholder="Search entities…"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
        />
        {refreshing && <span title="Refreshing entities from the server…"><Spinner /></span>}
      </div>

      <div className="solution-row">
        <button
          type="button"
          className={'chip' + (solutionFilter ? ' active' : '')}
          onClick={onPickSolution}
        >
          <span className="chip-label">{solutionFilter ? solutionFilter.name : 'All solutions'}</span>
          <span aria-hidden="true">▾</span>
        </button>
        {solutionFilter && (
          <button type="button" className="chip-clear" title="Clear solution filter" onClick={onClearSolution}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
