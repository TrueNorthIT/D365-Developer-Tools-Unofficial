import type { RibbonControl } from '../protocol';
import { selectionGroupId, selectionTabId, type Location, type Selection } from '../ribbonState';

interface Props {
  entityDisplayName: string;
  entityLogicalName: string;
  ribbonLocationLabel: string;
  selection: Selection;
  location: Location | 'All';
  availableLocations: Location[];
  onLocationChange: (location: Location | 'All') => void;
  onAddTab: () => void;
  onAddGroup: (tabId: string) => void;
  onAddControl: (tabId: string, groupId: string, kind: RibbonControl['kind']) => void;
  onDelete: () => void;
  onReload: () => void;
  onExport: () => void;
  onPublish: () => void;
}

const CONTROL_KINDS: RibbonControl['kind'][] = ['Button', 'SplitButton', 'FlyoutAnchor'];

export function Toolbar(props: Props) {
  const { entityDisplayName, entityLogicalName, ribbonLocationLabel, selection, location, availableLocations, onLocationChange, onAddTab, onAddGroup, onAddControl, onDelete, onReload, onExport, onPublish } = props;
  const tabId = selectionTabId(selection);
  const groupId = selectionGroupId(selection);

  return (
    <div className="ribbon-toolbar">
      <div className="ribbon-toolbar-title">
        <strong>{entityDisplayName || entityLogicalName}{ribbonLocationLabel && ` — ${ribbonLocationLabel}`}</strong>
        <span className="entity-lname">{entityLogicalName}</span>
      </div>
      <div className="ribbon-toolbar-actions">
        <label className="location-select">
          Location
          <select value={location} onChange={e => onLocationChange(e.target.value as Location | 'All')}>
            <option value="All">All</option>
            {availableLocations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
          </select>
        </label>
        <button type="button" onClick={onAddTab}>+ Tab</button>
        <button type="button" disabled={!tabId} onClick={() => tabId && onAddGroup(tabId)}>+ Group</button>
        <select
          disabled={!tabId || !groupId}
          value=""
          onChange={e => {
            const kind = e.target.value as RibbonControl['kind'] | '';
            if (kind && tabId && groupId) { onAddControl(tabId, groupId, kind); }
            e.target.value = '';
          }}
        >
          <option value="">+ Control…</option>
          {CONTROL_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <button type="button" disabled={!selection} onClick={onDelete}>Delete / Restore</button>
        <span className="ribbon-toolbar-spacer" />
        <button type="button" onClick={onReload}>Reload from Server</button>
        <button type="button" onClick={onExport}>Export RibbonDiffXml</button>
        <button type="button" className="primary" onClick={onPublish}>Publish to Dynamics</button>
      </div>
    </div>
  );
}
