import { useLayoutEffect, useRef, useState } from 'react';
import type { RibbonLocation } from '../protocol';

export type ContextTarget =
  | { kind: 'entity'; logicalName: string; displayName: string }
  | {
      kind: 'attr';
      entityLogicalName: string;
      attributeLogicalName: string;
      attributeDisplayName: string;
      attributeType: string;
    };

interface Props {
  target: ContextTarget;
  x: number;
  y: number;
  onClose: () => void;
  onMakeInterface: (logicalName: string, displayName: string) => void;
  onMakeEnum: (
    entityLogicalName: string,
    attributeLogicalName: string,
    attributeDisplayName: string,
    attributeType: string,
  ) => void;
  onOpenRibbonEditor: (logicalName: string, displayName: string, ribbonLocation: RibbonLocation) => void;
}

export function ContextMenu({ target, x, y, onClose, onMakeInterface, onMakeEnum, onOpenRibbonEditor }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp within the viewport once we know the rendered size (ports showCtx()), and re-clamp
  // whenever the menu's own size changes (e.g. the ribbon-location accordion expands) — this is a
  // sidebar webview, so `window.innerWidth/Height` are the narrow panel's own dimensions, not the
  // whole VS Code window; growing content can easily push the menu off that panel's edge.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) { return; }

    const clamp = () => {
      const r = menu.getBoundingClientRect();
      let nx = x;
      let ny = y;
      if (x + r.width > window.innerWidth) { nx = Math.max(0, x - r.width); }
      if (y + r.height > window.innerHeight) { ny = Math.max(0, y - r.height); }
      setPos({ x: nx, y: ny });
    };

    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [x, y]);

  // Dismiss on outside click, scroll, or Escape. Clicks *inside* the menu are left to each item's
  // own onClick (action buttons already call onClose() themselves before acting) — this matters
  // now that the ribbon-location accordion trigger needs a click to toggle it open without closing
  // the whole menu, which an unconditional "close on any click" would prevent.
  useLayoutEffect(() => {
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) { return; }
      onClose();
    };
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
    document.addEventListener('click', closeOnOutsideClick);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const handleInterface = () => {
    onClose();
    if (target.kind === 'entity') { onMakeInterface(target.logicalName, target.displayName); }
  };
  const handleEnum = () => {
    onClose();
    if (target.kind === 'attr') {
      onMakeEnum(
        target.entityLogicalName,
        target.attributeLogicalName,
        target.attributeDisplayName,
        target.attributeType,
      );
    }
  };
  const handleRibbonLocation = (ribbonLocation: RibbonLocation) => {
    onClose();
    if (target.kind === 'entity') { onOpenRibbonEditor(target.logicalName, target.displayName, ribbonLocation); }
  };

  return (
    <div id="ctx-menu" ref={menuRef} style={{ left: pos.x, top: pos.y }}>
      {target.kind === 'entity' && <button onClick={handleInterface}>Make Interface</button>}
      {target.kind === 'entity' && <RibbonEditorFlyout onPick={handleRibbonLocation} />}
      {target.kind === 'attr' && <button onClick={handleEnum}>Make Enum</button>}
    </div>
  );
}

const RIBBON_LOCATIONS: Array<{ value: RibbonLocation; label: string }> = [
  { value: 'Form', label: 'Main Form' },
  { value: 'HomepageGrid', label: 'Home Grid' },
  { value: 'SubGrid', label: 'Sub-Grid' },
];

// A sideways flyout doesn't fit reliably here: this menu lives in a sidebar webview, which is
// often only ~250-350px wide, and the menu is already clamped toward that panel's edge — flipping
// a submenu further sideways can just push it off the opposite edge instead. Expanding downward,
// inline in the same popup, only needs vertical room, which a sidebar has plenty of.
// Opens on hover, like a normal flyout; also toggles on click so it's reachable by keyboard/touch
// (safe now that the outside-click handler above only closes the whole menu for clicks that land
// outside it, not for every click).
function RibbonEditorFlyout({ onPick }: { onPick: (location: RibbonLocation) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="ctx-menu-flyout" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="ctx-menu-flyout-trigger" onClick={() => setOpen(o => !o)}>
        Edit Ribbon
        <span className={'ctx-menu-flyout-arrow' + (open ? ' open' : '')}>▾</span>
      </button>
      {open && (
        <div className="ctx-submenu">
          {RIBBON_LOCATIONS.map(loc => (
            <button key={loc.value} type="button" onClick={() => onPick(loc.value)}>{loc.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
