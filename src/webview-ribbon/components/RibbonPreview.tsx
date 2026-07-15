import { useLayoutEffect, useRef, useState, type DragEvent } from 'react';
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
  onReorderControl: (groupId: string, controlId: string, beforeControlId: string | null) => void;
}

// Renders the ribbon roughly as it appears in Dynamics itself: a tab strip, then the active tab's
// groups as bordered boxes containing icon+label button tiles — replacing the earlier plain text
// tree, which was unusable once real data showed up (hundreds of buttons/commands/rules at once).
export function RibbonPreview({ model, location, activeTabId, onActiveTabChange, selection, onSelect, onReorderControl }: Props) {
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
            onReorderControl={onReorderControl}
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
function RibbonGroupLines({ groups, selection, onSelect, activeTabId, onControlSelect, onReorderControl }: {
  groups: RibbonGroup[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  activeTabId: string;
  onControlSelect: (groupId: string, controlId: string) => void;
  onReorderControl: (groupId: string, controlId: string, beforeControlId: string | null) => void;
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
            <GroupButtons
              groupId={group.id}
              controls={group.controls.filter(c => c.status !== 'deleted')}
              selection={selection}
              onControlSelect={onControlSelect}
              onReorderControl={onReorderControl}
            />
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

// Native HTML5 drag-and-drop, scoped to reordering within a single group -- dragging a tile over a
// different group's buttons is simply not wired up (no onDragOver there), so the browser shows a
// "no drop" cursor and onReorderControl is never called across groups.
//
// insertBeforeId is exactly the `beforeControlId` that would be sent to onReorderControl right now
// -- a real control id to land before, or null to land at the end -- so the drop-indicator bar is
// rendered as an actual flex sibling at that same position (flatMap below) rather than a border
// drawn on some tile, guaranteeing the indicator can never point somewhere other than where the
// drop will actually land. undefined (vs. null) means "no drag in progress over this group yet",
// so no bar renders until the pointer actually moves over it.
function GroupButtons({ groupId, controls, selection, onControlSelect, onReorderControl }: {
  groupId: string;
  controls: RibbonControl[];
  selection: Selection;
  onControlSelect: (groupId: string, controlId: string) => void;
  onReorderControl: (groupId: string, controlId: string, beforeControlId: string | null) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [insertBeforeId, setInsertBeforeId] = useState<string | null | undefined>(undefined);

  const endDrag = () => {
    setDraggingId(null);
    setInsertBeforeId(undefined);
  };

  const commitDrop = () => {
    if (!draggingId) { return; }
    onReorderControl(groupId, draggingId, insertBeforeId ?? null);
    endDrag();
  };

  return (
    <div
      className="ribbon-group-buttons"
      onDragOver={e => {
        if (!draggingId) { return; }
        e.preventDefault();
        if ((e.target as HTMLElement).closest('.ribbon-button-tile') === null) {
          setInsertBeforeId(null); // hovering empty space in the group -> land at the end
        }
      }}
      onDrop={e => { if (!draggingId) { return; } e.preventDefault(); commitDrop(); }}
    >
      {controls.flatMap((control, i) => {
        const nodes = [];
        if (draggingId && insertBeforeId === control.id) {
          nodes.push(<span key={`drop-${control.id}`} className="ribbon-drop-indicator" />);
        }
        nodes.push(
          <ButtonTile
            key={control.id}
            control={control}
            selected={selection?.kind === 'control' && selection.id === control.id}
            onSelect={() => onControlSelect(groupId, control.id)}
            dragging={draggingId === control.id}
            onDragStart={() => { setDraggingId(control.id); setInsertBeforeId(undefined); }}
            onDragEnd={endDrag}
            onDragOverTile={e => {
              if (!draggingId) { return; }
              e.preventDefault(); // always allow the drop here, even over the dragged tile itself -- otherwise the browser shows a "not allowed" cursor while passing over its own source
              e.stopPropagation();
              if (draggingId === control.id) { return; } // ambiguous relative to itself -- leave insertBeforeId at the last real target instead of guessing
              const rect = e.currentTarget.getBoundingClientRect();
              const before = e.clientX - rect.left < rect.width / 2;
              setInsertBeforeId(before ? control.id : (controls[i + 1]?.id ?? null));
            }}
            onDropOnTile={e => { if (!draggingId) { return; } e.preventDefault(); e.stopPropagation(); commitDrop(); }}
          />,
        );
        return nodes;
      })}
      {draggingId && insertBeforeId === null && <span key="drop-end" className="ribbon-drop-indicator" />}
    </div>
  );
}

function ButtonTile({ control, selected, onSelect, dragging, onDragStart, onDragEnd, onDragOverTile, onDropOnTile }: {
  control: RibbonControl;
  selected: boolean;
  onSelect: () => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverTile: (e: DragEvent<HTMLButtonElement>) => void;
  onDropOnTile: (e: DragEvent<HTMLButtonElement>) => void;
}) {
  const hasChevron = control.kind === 'SplitButton' || control.kind === 'FlyoutAnchor';
  const label = displayText(control.label, control.id);
  const dragClass = dragging ? ' dragging' : '';
  return (
    <button
      type="button"
      draggable
      className={'ribbon-button-tile' + (selected ? ' selected' : '') + statusSuffix(control.status) + dragClass}
      onClick={onSelect}
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', control.id);
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0); // cursor sits at the ghost's top-left corner, not centered on it
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverTile}
      onDrop={onDropOnTile}
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
