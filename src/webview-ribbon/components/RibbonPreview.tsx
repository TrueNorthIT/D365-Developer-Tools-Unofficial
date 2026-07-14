import type { RibbonControl, RibbonModel, RibbonNodeStatus, RibbonTab } from '../protocol';
import { displayText, locationOf, type Location, type Selection } from '../ribbonState';
import { RibbonIcon } from './RibbonIcon';

interface Props {
  model: RibbonModel;
  location: Location | 'All';
  activeTabId: string | undefined;
  onActiveTabChange: (tabId: string) => void;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

// Renders the ribbon roughly as it appears in Dynamics itself: a tab strip, then the active tab's
// groups as bordered boxes containing icon+label button tiles — replacing the earlier plain text
// tree, which was unusable once real data showed up (hundreds of buttons/commands/rules at once).
export function RibbonPreview({ model, location, activeTabId, onActiveTabChange, selection, onSelect }: Props) {
  const visibleTabs = model.tabs.filter(t => t.status !== 'deleted' && (location === 'All' || locationOf(t.id) === location));
  const activeTab = visibleTabs.find(t => t.id === activeTabId) ?? visibleTabs[0];

  if (visibleTabs.length === 0) {
    return <div className="ribbon-preview-empty">No tabs match this location filter.</div>;
  }

  const visibleGroups = (activeTab?.groups ?? []).filter(g => g.status !== 'deleted');

  return (
    <div className="ribbon-preview">
      <div className="ribbon-tabstrip">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={'ribbon-tab' + (tab.id === activeTab?.id ? ' active' : '') + statusSuffix(tab.status)}
            onClick={() => onActiveTabChange(tab.id)}
            onDoubleClick={() => onSelect({ kind: 'tab', id: tab.id })}
            title={tab.title || tab.id}
          >
            {displayText(tab.title, tab.id)}
          </button>
        ))}
      </div>

      <div className="ribbon-groups">
        {visibleGroups.length === 0 && <div className="ribbon-preview-empty">This tab has no groups.</div>}
        {visibleGroups.map(group => (
          <div key={group.id} className={'ribbon-group' + statusSuffix(group.status)}>
            <div className="ribbon-group-buttons">
              {group.controls.filter(c => c.status !== 'deleted').map(control => (
                <ButtonTile
                  key={control.id}
                  control={control}
                  selected={selection?.kind === 'control' && selection.id === control.id}
                  onSelect={() => onSelect({ kind: 'control', tabId: activeTab!.id, groupId: group.id, id: control.id })}
                />
              ))}
            </div>
            <button
              type="button"
              className={'ribbon-group-caption' + (selection?.kind === 'group' && selection.id === group.id ? ' selected' : '')}
              onClick={() => onSelect({ kind: 'group', tabId: activeTab!.id, id: group.id })}
              title={group.title || group.id}
            >
              {displayText(group.title, group.id)}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ButtonTile({ control, selected, onSelect }: { control: RibbonControl; selected: boolean; onSelect: () => void }) {
  const hasChevron = control.kind === 'SplitButton' || control.kind === 'FlyoutAnchor';
  const label = displayText(control.label, control.id);
  return (
    <button
      type="button"
      className={'ribbon-button-tile' + (selected ? ' selected' : '') + statusSuffix(control.status)}
      onClick={onSelect}
      title={control.toolTipTitle || control.label || control.id}
    >
      <RibbonIcon iconRef={control.image32 ?? control.image16} alt="" />
      <span className="ribbon-button-label">{label}{hasChevron && ' ▾'}</span>
    </button>
  );
}

function statusSuffix(status: RibbonNodeStatus): string {
  return status === 'unchanged' ? '' : ` status-${status}`;
}

// Re-exported so App.tsx can compute the set of locations actually present without re-deriving the
// same filter logic.
export function distinctLocations(tabs: RibbonTab[]): Location[] {
  const found = new Set<Location>();
  for (const tab of tabs) {
    if (tab.status === 'deleted') { continue; }
    found.add(locationOf(tab.id));
  }
  return [...found];
}
