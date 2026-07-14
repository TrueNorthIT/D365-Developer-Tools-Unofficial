import { useLayoutEffect, useRef, useState } from 'react';
import type { RibbonControl, RibbonGroup, RibbonModel, RibbonNodeStatus, RibbonTab } from '../protocol';
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
    return <div className="ribbon-preview"><div className="ribbon-preview-empty">No tabs match this location filter.</div></div>;
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

      {visibleGroups.length === 0
        ? <div className="ribbon-preview-empty">This tab has no groups.</div>
        : (
          <RibbonGroupLines
            groups={visibleGroups}
            selection={selection}
            onSelect={onSelect}
            activeTabId={activeTab!.id}
            onControlSelect={(groupId, controlId) => onSelect({ kind: 'control', tabId: activeTab!.id, groupId, id: controlId })}
          />
        )}
    </div>
  );
}

// A "line" is a row of groups that wrapped together, detected by measuring which groups share the
// same top offset (flexbox wraps to a new row only when a group no longer fits, so same top ==
// same visual row). Each detected line gets its own absolutely-positioned background rectangle
// sized to that row's groups -- rendering as a distinct floating "ribbon" per row, the way the real
// Dynamics ribbon looks, rather than one giant card spanning every wrapped row. Group captions stay
// in normal flow below their own group (outside the rectangle, which only covers the button area),
// so they aren't part of the pinned-color card and use the surrounding theme like everything else.
//
// Recomputed on mount/group-set change and on resize (a ResizeObserver, since the panel itself can
// be resized, changing how many groups fit per row) -- there's no way to ask CSS which row a
// flex-wrap item landed in, so this measures the real DOM after layout.
function RibbonGroupLines({ groups, selection, onSelect, activeTabId, onControlSelect }: {
  groups: RibbonGroup[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  activeTabId: string;
  onControlSelect: (groupId: string, controlId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupElements = useRef(new Map<string, HTMLDivElement>());
  const [lineRects, setLineRects] = useState<Array<{ top: number; left: number; width: number; height: number }>>([]);
  // Every group id except the last one in its line -- these get a right-side divider (see
  // .ribbon-group.has-divider) so groups sharing a ribbon read as separate sections without
  // actually cutting the shared background rectangle into pieces.
  const [dividerAfter, setDividerAfter] = useState<Set<string>>(new Set());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) { return; }

    const measure = () => {
      const entries = groups.map(g => {
        const el = groupElements.current.get(g.id);
        return el ? { id: g.id, rect: el.getBoundingClientRect() } : undefined;
      });
      if (entries.some(e => !e)) { return; } // not all groups mounted yet
      const valid = entries as Array<{ id: string; rect: DOMRect }>;

      const containerRect = container.getBoundingClientRect();
      const lines: Array<Array<{ id: string; rect: DOMRect }>> = [];
      for (const entry of valid) {
        const currentLine = lines[lines.length - 1];
        if (currentLine && Math.abs(entry.rect.top - currentLine[0].rect.top) < 1) {
          currentLine.push(entry);
        } else {
          lines.push([entry]);
        }
      }

      setLineRects(lines.map(line => {
        const left = Math.min(...line.map(e => e.rect.left));
        const right = Math.max(...line.map(e => e.rect.right));
        return {
          top: line[0].rect.top - containerRect.top,
          left: left - containerRect.left,
          width: right - left,
          height: Math.max(...line.map(e => e.rect.height)),
        };
      }));

      const dividers = new Set<string>();
      for (const line of lines) {
        for (const entry of line.slice(0, -1)) { dividers.add(entry.id); }
      }
      setDividerAfter(dividers);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [groups]);

  return (
    <div className="ribbon-groups" ref={containerRef}>
      {lineRects.map((rect, i) => (
        <div key={i} className="ribbon-line-bg" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
      ))}
      {groups.map(group => (
        <div key={group.id} className="ribbon-group-block">
          <div
            className={'ribbon-group' + statusSuffix(group.status) + (dividerAfter.has(group.id) ? ' has-divider' : '')}
            ref={el => {
              if (el) { groupElements.current.set(group.id, el); }
              else { groupElements.current.delete(group.id); }
            }}
          >
            <div className="ribbon-group-buttons">
              {group.controls.filter(c => c.status !== 'deleted').map(control => (
                <ButtonTile
                  key={control.id}
                  control={control}
                  selected={selection?.kind === 'control' && selection.id === control.id}
                  onSelect={() => onControlSelect(group.id, control.id)}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            className={'ribbon-group-caption' + (selection?.kind === 'group' && selection.id === group.id ? ' selected' : '')}
            onClick={() => onSelect({ kind: 'group', tabId: activeTabId, id: group.id })}
            title={group.title || group.id}
          >
            {displayText(group.title, group.id)}
          </button>
        </div>
      ))}
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
      <RibbonIcon modernImage={control.modernImage} image={control.image32 ?? control.image16} alt="" />
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
