import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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

const SEARCH_DEBOUNCE_MS = 250;

/** Web resource names matching `query`, search-as-you-type for the icon/library fields in
 *  NodeEditor.tsx and RuleDialog.tsx. Debounced client-side (typing doesn't fire a request per
 *  keystroke) and cached briefly per exact query string -- long enough to avoid re-querying while
 *  flipping between two recently-typed values, short enough that a web resource created moments
 *  ago in another tab shows up soon. */
export function useWebResourceSearch(query: string) {
  const [debounced, setDebounced] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return useQuery({
    queryKey: ['webResourceSearch', debounced],
    queryFn: () => request('searchWebResources', { query: debounced }),
    enabled: debounced.trim().length > 0,
    staleTime: 30_000,
  });
}
