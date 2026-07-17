import { useQuery } from '@tanstack/react-query';
import type { AttributeInfo } from './protocol';
import { request } from './rpc';
import { decodeIconContent, type IconContent } from './helpers';

// Schema data barely changes within a session, so cache aggressively and never treat it as
// stale on its own; it's explicitly dropped on reconnect (see useExtensionState).

/** A table's attributes, fetched the first time the row is expanded. */
export function useAttributes(entityLogicalName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['attributes', entityLogicalName],
    queryFn: () => request('getAttributes', { entityLogicalName }),
    enabled,
    staleTime: Infinity,
  });
}

/**
 * A table's icon, decoded to inline SVG markup or a raster data: URI (or null when it has none).
 * `key` is the icon source key from helpers.iconKey(); the query is disabled when there's nothing
 * to fetch.
 */
export function useIcon(key: string | null) {
  return useQuery({
    queryKey: ['icon', key],
    queryFn: () => request('getIcon', { key: key as string }),
    enabled: !!key,
    staleTime: Infinity,
    select: (content): IconContent | null => (content ? decodeIconContent(content) : null),
  });
}

export type { AttributeInfo };
