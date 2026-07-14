import { useQuery } from '@tanstack/react-query';
import { request } from './rpc';

// Ribbon icon references barely change within a session (same button, same icon), so cache
// aggressively — same pattern as src/webview/queries.ts's useIcon().

/** A ribbon control's icon (image16/image32 reference), resolved to a data: URI, or null if unresolvable. */
export function useRibbonIcon(ref: string | undefined) {
  return useQuery({
    queryKey: ['ribbonIcon', ref],
    queryFn: () => request('getIcon', { ref: ref as string }),
    enabled: !!ref,
    staleTime: Infinity,
  });
}
