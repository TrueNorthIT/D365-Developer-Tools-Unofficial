import type { EntityInfo } from './protocol';

// ── Attribute type badges (ported 1:1 from the old inline webview) ─────────────

export function shortType(t: string): string {
  const map: Record<string, string> = {
    String: 'str', Memo: 'str', Integer: 'int', BigInt: 'int',
    Double: 'dec', Decimal: 'dec', Boolean: 'bool', DateTime: 'date',
    Money: '$', Lookup: 'lkp', Customer: 'lkp', Owner: 'lkp',
    Picklist: 'opt', State: 'state', Status: 'status',
    Uniqueidentifier: 'uid', EntityName: 'ent', Virtual: 'virt',
  };
  return map[t] || t;
}

export function typeClass(t: string): string {
  if (t === 'String' || t === 'Memo' || t === 'EntityName') { return 't-str'; }
  if (t === 'Integer' || t === 'BigInt' || t === 'Double' || t === 'Decimal') { return 't-num'; }
  if (t === 'Boolean') { return 't-bool'; }
  if (t === 'DateTime') { return 't-date'; }
  if (t === 'Lookup' || t === 'Customer' || t === 'Owner') { return 't-lkp'; }
  if (t === 'Picklist' || t === 'State' || t === 'Status') { return 't-opt'; }
  if (t === 'Uniqueidentifier') { return 't-key'; }
  return 't-def';
}

export const OPTION_SET_TYPES = new Set(['Picklist', 'State', 'Status']);

// ── Icons ──────────────────────────────────────────────────────────────────────

// A stable key identifying where a table's icon comes from:
//   'wr:<name>'  → custom table's IconVectorName web resource
//   'otc:<code>' → system table's built-in /_imgs/svg_<otc>.svg icon
// null → nothing to fetch; show the generic glyph.
export function iconKey(e: EntityInfo): string | null {
  if (e.iconVectorName) { return 'wr:' + e.iconVectorName; }
  if (typeof e.objectTypeCode === 'number') { return 'otc:' + e.objectTypeCode; }
  return null;
}

export type IconContent =
  | { kind: 'svg'; markup: string }
  | { kind: 'raster'; dataUri: string };

// IconVectorName nominally points at an SVG web resource, but nothing stops a table from having
// a raster one configured there instead -- sniffs the decoded bytes' magic number rather than
// trusting that, since blindly UTF-8-decoding a PNG/JPEG/GIF and inlining it as "SVG markup"
// dumps the raw binary as garbled text into the DOM.
function sniffRasterMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) { return 'image/png'; }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { return 'image/jpeg'; }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) { return 'image/gif'; }
  return undefined;
}

// Decode base64 web-resource content, detecting whether it's actually a raster image (rendered as
// a data: URI <img>) or real SVG/XML text (stripped of its prolog / DOCTYPE so it inlines cleanly
// -- script execution inside it is blocked by the page CSP either way).
export function decodeIconContent(b64: string): IconContent {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }

  const rasterMimeType = sniffRasterMimeType(bytes);
  if (rasterMimeType) { return { kind: 'raster', dataUri: `data:${rasterMimeType};base64,${b64}` }; }

  const svg = new TextDecoder('utf-8').decode(bytes);
  return { kind: 'svg', markup: svg.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!DOCTYPE[\s\S]*?>/i, '').trim() };
}

// Inline table glyph shown when a real icon isn't available (or hasn't loaded yet).
// currentColor picks up the theme foreground.
export const GENERIC_ENTITY_ICON =
  '<svg class="entity-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" stroke="currentColor" stroke-width="1.1"/>'
  + '<line x1="1.75" y1="6.25" x2="14.25" y2="6.25" stroke="currentColor" stroke-width="1.1"/>'
  + '<line x1="6" y1="6.25" x2="6" y2="13.25" stroke="currentColor" stroke-width="1.1"/>'
  + '<line x1="10" y1="6.25" x2="10" y2="13.25" stroke="currentColor" stroke-width="1.1"/>'
  + '</svg>';
