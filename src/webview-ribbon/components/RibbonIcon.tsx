import { useIsMonochromeIcon, useRibbonIcon } from '../queries';

// Renders a ribbon control's icon: the resolved image (data: URI) once loaded, otherwise a blank
// placeholder tile — matches EntityIcon.tsx's "real icon or generic fallback" shape, but there's no
// sensible generic glyph for an arbitrary ribbon button, so an empty box is the fallback instead.
//
// `modernImage` is preferred when it resolves to something -- most values are one of Dataverse's
// built-in Fluent icon names rather than a web resource, so it usually resolves to nothing and
// `image` (Image32by32 ?? Image16by16) is what actually renders. Both are queried unconditionally
// (rather than only falling back once `modernImage` is known to have failed) so a control with no
// modern icon at all doesn't pay for a sequential round trip before showing its classic one.
//
// The `mono` class marks icons whose content is actually monochrome (see isMonochromeImage) --
// under a dark theme, styles.css inverts only those, so the (mostly black line-art) icon set stays
// legible against the dark ribbon card without also inverting the handful of icons that already
// have color.
export function RibbonIcon({ modernImage, image, alt }: { modernImage: string | undefined; image: string | undefined; alt: string }) {
  const modern = useRibbonIcon(modernImage);
  const classic = useRibbonIcon(image);
  const src = modern.data || classic.data;
  const mono = useIsMonochromeIcon(src);

  if (!src) {
    return <span className="ribbon-icon-slot placeholder" aria-hidden="true" />;
  }
  return <img className={'ribbon-icon-slot' + (mono.data ? ' mono' : '')} src={src} alt={alt} />;
}
