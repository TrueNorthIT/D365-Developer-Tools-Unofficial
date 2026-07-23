import { MODERN_ICONS } from './modernIcons';

// Fallback for a ribbon control's ModernImage when it's one of Dataverse's built-in icon names
// (e.g. "New") rather than a web resource -- see the doc comment on RibbonControl.modernImage
// (src/ribbon/ribbonModel.ts) and getRibbonImageContent (src/dataverseClient.ts) for why that
// lookup finds nothing for most ModernImage values.
//
// MODERN_ICONS (modernIcons.ts) is real data extracted from a live Unified Interface client bundle,
// not a guess -- see that file's header for how it was captured and how to extend it. Two earlier
// approaches were tried and reverted before this one: (1) converting ModernImage's PascalCase to
// snake_case and searching the full @fluentui/svg-icons package for a same-named file -- often
// matched a real but unrelated icon of the same converted name, rendering the wrong glyph entirely;
// (2) a small hand-verified table of individually-confirmed mappings -- correct but required manually
// capturing and verifying each name one at a time, which doesn't scale.

/** Resolves a ModernImage name to a data: URI via MODERN_ICONS, or undefined if this name isn't
 *  covered (see that file's header for what "covered" means). */
export function resolveFluentIconDataUri(name: string): string | undefined {
    const svg = MODERN_ICONS[name.trim()];
    return svg ? `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}` : undefined;
}
