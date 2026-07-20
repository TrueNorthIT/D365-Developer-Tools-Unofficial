import type { IconContent } from '../helpers';
import { GENERIC_ENTITY_ICON } from '../helpers';

// Renders a table's icon: the decoded real SVG or raster image once loaded, otherwise the generic
// glyph. Fetching/caching/dedupe is handled by useIcon (TanStack Query); virtualization means only
// visible rows mount, so there's no need for the old in-view IntersectionObserver gating.
export function EntityIcon({ content }: { content?: IconContent | null }) {
  if (content?.kind === 'raster') {
    return (
      <span className="entity-icon-slot real-icon">
        <img src={content.dataUri} alt="" />
      </span>
    );
  }

  const markup = content?.kind === 'svg' ? content.markup : GENERIC_ENTITY_ICON;
  return (
    <span
      className={'entity-icon-slot' + (content ? ' real-icon' : '')}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
