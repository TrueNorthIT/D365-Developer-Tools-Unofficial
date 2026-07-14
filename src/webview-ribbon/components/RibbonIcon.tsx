import { useRibbonIcon } from '../queries';

// Renders a ribbon control's icon: the resolved image (data: URI) once loaded, otherwise a blank
// placeholder tile — matches EntityIcon.tsx's "real icon or generic fallback" shape, but there's no
// sensible generic glyph for an arbitrary ribbon button, so an empty box is the fallback instead.
export function RibbonIcon({ iconRef, alt }: { iconRef: string | undefined; alt: string }) {
  const icon = useRibbonIcon(iconRef);
  const src = icon.data;

  if (!src) {
    return <span className="ribbon-icon-slot placeholder" aria-hidden="true" />;
  }
  return <img className="ribbon-icon-slot" src={src} alt={alt} />;
}
