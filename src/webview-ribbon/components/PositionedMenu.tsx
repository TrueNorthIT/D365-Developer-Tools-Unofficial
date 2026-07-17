import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Shared positioning/dismissal shell for every right-click menu in this webview (button tile, group,
// tab strip -- RibbonPreview.tsx; rule tile -- NodeEditor.tsx): repositions near the click point but
// never off-screen, and closes on an outside click, any scroll, or Escape. Follows the same pattern
// as the entity explorer's ContextMenu (src/webview/components/ContextMenu.tsx) -- kept separate
// rather than shared across webviews since the two have no target/action shape in common beyond this
// dismissal behavior.
export function PositionedMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) { return; }
    const r = menu.getBoundingClientRect();
    setPos({
      x: x + r.width > window.innerWidth ? Math.max(0, x - r.width) : x,
      y: y + r.height > window.innerHeight ? Math.max(0, y - r.height) : y,
    });
  }, [x, y]);

  useLayoutEffect(() => {
    const closeOnOutsideClick = (e: globalThis.MouseEvent) => {
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

  return (
    <div className="ribbon-ctx-menu" ref={menuRef} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  );
}
