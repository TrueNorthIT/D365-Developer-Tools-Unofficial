import { useQuery } from '@tanstack/react-query';
import { isMonochromeImage } from './isMonochromeImage';
import { request } from './rpc';

// Ribbon icon references barely change within a session (same button, same icon), so cache
// aggressively — same pattern as src/webview/queries.ts's useIcon().

/** A ribbon control's icon reference (Image16by16/Image32by32/ModernImage), resolved to a data: URI, or null if unresolvable. */
export function useRibbonIcon(ref: string | undefined) {
  return useQuery({
    queryKey: ['ribbonIcon', ref],
    queryFn: () => request('getIcon', { ref: ref as string }),
    enabled: !!ref,
    staleTime: Infinity,
  });
}

/** Whether a resolved icon's image content is monochrome (see isMonochromeImage) -- a property of
 *  the image itself, independent of the current VS Code theme, so it's safe to cache forever. */
export function useIsMonochromeIcon(src: string | null | undefined) {
  return useQuery({
    queryKey: ['ribbonIconMono', src],
    queryFn: () => isMonochromeImage(src as string),
    enabled: !!src,
    staleTime: Infinity,
  });
}
