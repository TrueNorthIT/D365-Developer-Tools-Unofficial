import { normaliseGuid } from './formModel';
import type { FormControl, FormModel, TableAttribute, TableModel, ViewColumn } from './formModel';

/**
 * Pure logic behind the form previewer's live record selector: builds the read-only FetchXML queries (lookup search,
 * the record itself, subgrid rows, quick view records) and turns Web API records into display text. No `vscode` import.
 *
 * Every query is built here from trusted parts (logical names from metadata, a validated GUID); user text only ever
 * appears LIKE-escaped and XML-escaped inside an attribute value. Nothing here writes to Dataverse.
 */

/** Primary id / primary name attribute logical names of an entity (from live `EntityDefinitions` metadata; the table YAML does not carry them). */
export interface PrimaryAttributes {
    id: string;
    name: string;
}

export type RelationshipInfo =
    | { kind: 'OneToMany'; referencingAttribute: string }
    | {
        kind: 'ManyToMany';
        intersectEntity: string;
        thisEntityIntersectAttribute: string;
        otherEntityIntersectAttribute: string;
        otherEntityPrimaryId: string;
    };

export interface LookupResult {
    id: string;
    primary: string;
    secondary: string[];
}

export interface FieldDisplay {
    text: string;
    kind: 'text' | 'link' | 'empty';
}

export interface QuickViewRef {
    /** Entity the quick view form belongs to (the lookup's target). */
    entity: string;
    /** Id of the related record (from `_<field>_value`), lower-case, no braces. */
    id: string;
    /** Id of the quick view form, when the control names one. */
    formId?: string;
}

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const LOOKUP_LOGICAL_NAME = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const EMPTY = '---';
export const NO_NAME = '(No name)';
/** Lines shown per lookup result: the primary name plus this many more Lookup View columns. */
const LOOKUP_RESULT_LINES = 3;

const GUID_RE = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
/** Logical names are letters, digits and underscores; anything else can't be a real attribute and is left out of a query. */
const LOGICAL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{\d+\}/;

/** Lower-case, brace-free GUID; throws when `id` isn't one, so nothing else can reach a query. */
export function requireGuid(id: unknown): string {
    const m = typeof id === 'string' ? GUID_RE.exec(id.trim()) : null;
    if (!m) { throw new Error(`Record id ${JSON.stringify(id)} is not a GUID.`); }
    return m[1].toLowerCase();
}

export function isGuid(id: unknown): boolean {
    return typeof id === 'string' && GUID_RE.test(id.trim());
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ── Strict FetchXML tree ────────────────────────────────────────────────────
// A small parser that rejects anything malformed (returns undefined) rather than guessing, so a half-typed or broken
// view falls back to a safe query instead of producing a different one.

interface XNode {
    name: string;
    attrs: Record<string, string>;
    children: XNode[];
    text: string;
    parent?: XNode;
    /** Offsets in the source: where the open tag starts, and where the close tag starts (= open tag end for self-closing). */
    start: number;
    closeStart: number;
    selfClosing: boolean;
}

const decodeXml = (s: string): string => s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/y;

function parseStrict(xml: string): XNode | undefined {
    const root: XNode = { name: '#root', attrs: {}, children: [], text: '', start: 0, closeStart: xml.length, selfClosing: false };
    let current = root;
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < xml.length) {
        const at = TOKEN.lastIndex;
        const m = TOKEN.exec(xml);
        if (!m) { return undefined; }
        const [whole, closing, name, rawAttrs, selfClosing, text] = m;
        if (text !== undefined) { current.text += decodeXml(text); continue; }
        if (!name) { continue; } // comment / processing instruction
        if (closing) {
            if (current.name !== name || selfClosing) { return undefined; }
            current.closeStart = at;
            current = current.parent!;
            continue;
        }
        const attrs: Record<string, string> = {};
        for (const a of (rawAttrs ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? '');
        }
        const node: XNode = {
            name, attrs, children: [], text: '', parent: current, start: at,
            closeStart: at + whole.length, selfClosing: !!selfClosing,
        };
        current.children.push(node);
        if (!selfClosing) { current = node; }
    }
    return current === root ? root : undefined;
}

function* descendants(node: XNode): Generator<XNode> {
    for (const child of node.children) {
        yield child;
        yield* descendants(child);
    }
}

/** The `<entity>` directly under the single `<fetch>`, or undefined. */
function rootEntity(tree: XNode | undefined): XNode | undefined {
    const fetch = tree?.children.find(c => c.name === 'fetch');
    return fetch?.children.find(c => c.name === 'entity');
}

function serialise(node: XNode): string {
    const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
    const inner = node.children.map(serialise).join('') + (node.text.trim() ? escapeXml(node.text) : '');
    return inner ? `<${node.name}${attrs}>${inner}</${node.name}>` : `<${node.name}${attrs} />`;
}

const hasPlaceholder = (node: XNode): boolean =>
    PLACEHOLDER_RE.test(node.attrs.value ?? '') || node.children.some(c => c.name === 'value' && PLACEHOLDER_RE.test(c.text));

/** A copy of a filter with Quick Find groups and `{n}` placeholder conditions removed; undefined when nothing is left. */
function stripFilter(filter: XNode): XNode | undefined {
    const children: XNode[] = [];
    for (const child of filter.children) {
        if (child.name === 'filter') {
            if (child.attrs.isquickfindfields === '1') { continue; }
            const inner = stripFilter(child);
            if (inner) { children.push(inner); }
        } else if (child.name === 'condition') {
            if (!hasPlaceholder(child)) { children.push(child); }
        }
    }
    return children.length ? { ...filter, children, text: '' } : undefined;
}

// ── Lookup search (REQ-3, REQ-4, REQ-5) ─────────────────────────────────────

/** Makes `%`, `_` and `[` match literally in a FetchXML `like` pattern. `[` goes first so the brackets added aren't escaped again. */
export function escapeLikeValue(text: string): string {
    let out = '';
    for (const ch of text) {
        out += ch === '[' ? '[[]' : ch === '%' ? '[%]' : ch === '_' ? '[_]' : ch;
    }
    return out;
}

/**
 * Search query for the lookup: the Quick Find view's search columns (the `like {0}` conditions in its
 * `isquickfindfields` filter) ORed together with a contains match on `searchText`, ANDed with the view's other filters,
 * selecting `resultColumns` plus the primary id. Falls back to a contains search on the primary name when there is no
 * usable Quick Find view. Blank text adds no search condition. The text is always data, never query syntax.
 */
export function buildLookupSearchFetch(
    entity: string, quickFindFetchXml: string | undefined, resultColumns: string[], searchText: string,
    primary: PrimaryAttributes, top = 10,
): string {
    const qfEntity = quickFindFetchXml ? rootEntity(parseStrict(quickFindFetchXml)) : undefined;

    let searchColumns: string[] = [];
    const keptFilters: XNode[] = [];
    const orders: XNode[] = [];
    if (qfEntity) {
        const findGroup = [...descendants(qfEntity)].find(n => n.name === 'filter' && n.attrs.isquickfindfields === '1'
            && !n.parent?.name.startsWith('link-entity'));
        if (findGroup) {
            searchColumns = [...descendants(findGroup)]
                .filter(c => c.name === 'condition' && c.attrs.operator === 'like' && c.attrs.value === '{0}' && c.attrs.attribute)
                .map(c => c.attrs.attribute);
        }
        for (const child of qfEntity.children) {
            if (child.name === 'filter' && child.attrs.isquickfindfields !== '1') {
                const kept = stripFilter(child);
                if (kept) { keptFilters.push(kept); }
            } else if (child.name === 'order' && child.attrs.attribute) {
                orders.push(child);
            }
        }
    }
    searchColumns = [...new Set(searchColumns)].filter(c => LOGICAL_NAME_RE.test(c));
    if (searchColumns.length === 0) { searchColumns = [primary.name]; }

    const text = searchText.trim();
    const pattern = escapeXml(`%${escapeLikeValue(text)}%`);
    const search = text
        ? '<filter type="or">' + searchColumns.map(c => `<condition attribute="${escapeXml(c)}" operator="like" value="${pattern}" />`).join('') + '</filter>'
        : '';
    const filters = keptFilters.map(serialise).join('') + search;

    const columns = [...new Set([...resultColumns, primary.id])].filter(c => LOGICAL_NAME_RE.test(c));
    const orderXml = orders.length
        ? orders.map(serialise).join('')
        : `<order attribute="${escapeXml(primary.name)}" descending="false" />`;
    return `<fetch version="1.0" mapping="logical" top="${Math.max(1, Math.floor(top))}"><entity name="${escapeXml(entity)}">`
        + columns.map(c => `<attribute name="${escapeXml(c)}" />`).join('')
        + orderXml
        + (filters ? `<filter type="and">${filters}</filter>` : '')
        + '</entity></fetch>';
}

/** Columns shown for each lookup result: the primary name, then the next Lookup View columns (root-table only), three lines in all. */
export function lookupResultColumns(lookupViewLayoutColumns: ViewColumn[] | undefined, primaryName: string): string[] {
    const rest = (lookupViewLayoutColumns ?? [])
        .map(c => c.name)
        .filter(n => n !== primaryName && !n.includes('.'));
    return [primaryName, ...new Set(rest)].slice(0, LOOKUP_RESULT_LINES);
}

/** Display text of a column in a Web API record: the formatted value first, then the raw value; lookups via `_x_value`. */
function cellText(record: Record<string, unknown>, column: string): string {
    for (const key of [column, `_${column}_value`]) {
        const formatted = record[`${key}${FORMATTED}`];
        if (typeof formatted === 'string' && formatted !== '') { return formatted; }
        const raw = record[key];
        if (raw !== undefined && raw !== null && raw !== '') {
            return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        }
    }
    return '';
}

export function mapLookupResult(record: Record<string, unknown>, columns: string[], primaryId: string): LookupResult {
    const [first, ...rest] = columns;
    return {
        id: normaliseGuid(record[primaryId]),
        primary: first ? cellText(record, first) : '',
        secondary: rest.map(c => cellText(record, c)).filter(Boolean),
    };
}

// ── Field values (REQ-7, REQ-8) ─────────────────────────────────────────────

const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);

/** What a form field shows for `record`: lookups as links (by name), choices/dates/money as Dynamics formats them, "---" when empty. */
export function fieldDisplay(record: Record<string, unknown>, attribute: string, attr?: TableAttribute): FieldDisplay {
    const lookupKey = `_${attribute}_value`;
    if (Object.prototype.hasOwnProperty.call(record, lookupKey) || LOOKUP_TYPES.has(attr?.type ?? '')) {
        const raw = record[lookupKey];
        if (raw === undefined || raw === null || raw === '') { return { text: EMPTY, kind: 'empty' }; }
        const name = record[`${lookupKey}${FORMATTED}`];
        return { text: typeof name === 'string' && name !== '' ? name : NO_NAME, kind: 'link' };
    }
    const formatted = record[`${attribute}${FORMATTED}`];
    if (typeof formatted === 'string' && formatted !== '') { return { text: formatted, kind: 'text' }; }
    const raw = record[attribute];
    if (raw === undefined || raw === null || raw === '') { return { text: EMPTY, kind: 'empty' }; }
    if (typeof raw === 'boolean') { return { text: raw ? 'Yes' : 'No', kind: 'text' }; }
    if (typeof raw === 'number') {
        const label = attr?.options?.get(raw);
        return { text: label ?? String(raw), kind: 'text' };
    }
    return { text: typeof raw === 'object' ? JSON.stringify(raw) : String(raw), kind: 'text' };
}

export function recordTitle(record: Record<string, unknown>, primaryName: string): string {
    return cellText(record, primaryName) || NO_NAME;
}

/** "Active - Saved", from the record's state; empty when the record has no statecode. */
export function recordStatus(record: Record<string, unknown>): string {
    const raw = record.statecode;
    const formatted = record[`statecode${FORMATTED}`];
    const state = typeof formatted === 'string' && formatted !== '' ? formatted
        : raw === undefined || raw === null ? '' : String(raw);
    return state ? `${state} - Saved` : '';
}

// ── Subgrid rows (REQ-9) ────────────────────────────────────────────────────

/**
 * The subgrid view's FetchXML limited to rows related to `recordId`: a one-to-many relationship adds an AND filter on the
 * referencing attribute; a many-to-many one adds an inner join through the intersect table filtered to this record.
 * The view's own columns, filters, orders and link-entities are kept. Throws on a non-GUID id; FetchXML that can't be
 * read is returned unchanged (callers compare to detect that, rather than running an unfiltered query).
 */
export function buildRelatedFetch(subgridFetchXml: string, rel: RelationshipInfo, recordId: string): string {
    const id = requireGuid(recordId);
    const tree = parseStrict(subgridFetchXml);
    const entity = rootEntity(tree);
    if (!tree || !entity) { return subgridFetchXml; }

    let addition: string;
    if (rel.kind === 'OneToMany') {
        addition = `<filter type="and"><condition attribute="${escapeXml(rel.referencingAttribute)}" operator="eq" value="${id}" /></filter>`;
    } else {
        const aliases = new Set([...descendants(tree)].map(n => n.attrs.alias).filter(Boolean));
        let alias = 'rel_intersect';
        for (let i = 1; aliases.has(alias); i++) { alias = `rel_intersect_${i}`; }
        addition = `<link-entity name="${escapeXml(rel.intersectEntity)}" from="${escapeXml(rel.otherEntityIntersectAttribute)}"`
            + ` to="${escapeXml(rel.otherEntityPrimaryId)}" link-type="inner" alias="${alias}" intersect="true">`
            + `<filter type="and"><condition attribute="${escapeXml(rel.thisEntityIntersectAttribute)}" operator="eq" value="${id}" /></filter>`
            + '</link-entity>';
    }

    if (entity.selfClosing) {
        // `<entity name="x" />` → `<entity name="x">…</entity>`.
        const tag = subgridFetchXml.slice(entity.start, entity.closeStart);
        const open = tag.replace(/\s*\/>$/, '>');
        return subgridFetchXml.slice(0, entity.start) + open + addition + '</entity>' + subgridFetchXml.slice(entity.closeStart);
    }
    return subgridFetchXml.slice(0, entity.closeStart) + addition + subgridFetchXml.slice(entity.closeStart);
}

// ── Reading the record (REQ-7, REQ-10) ──────────────────────────────────────

function allControls(model: FormModel): FormControl[] {
    const body = model.tabs.flatMap(t => t.columns.flatMap(c => c.sections.flatMap(s => s.controls)));
    return [...model.headerControls, ...body, ...model.footerControls];
}

/** Attribute logical names of every bound control (body, header, footer), de-duplicated; limited to `table`'s attributes when given. */
export function formFieldNames(model: FormModel, table?: TableModel): string[] {
    const names = new Set<string>();
    for (const c of allControls(model)) {
        if (c.field && (!table || table.attributes.has(c.field))) { names.add(c.field); }
    }
    return [...names];
}

/** FetchXML that reads one record by id: `attributes` plus the primary id, `top="1"`. Throws on a non-GUID `recordId`. */
export function buildRecordFetch(entity: string, attributes: string[], primaryId: string, recordId: string): string {
    const id = requireGuid(recordId);
    const columns = [...new Set([...attributes, primaryId])].filter(c => LOGICAL_NAME_RE.test(c));
    return `<fetch version="1.0" mapping="logical" top="1"><entity name="${escapeXml(entity)}">`
        + columns.map(c => `<attribute name="${escapeXml(c)}" />`).join('')
        + `<filter type="and"><condition attribute="${escapeXml(primaryId)}" operator="eq" value="${id}" /></filter>`
        + '</entity></fetch>';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `{entity, formId}` pairs a QuickViewForm control names in `parameters.QuickForms.xml.QuickFormIds.QuickFormId`. */
export function quickViewForms(control: FormControl): Array<{ entity: string; formId?: string }> {
    const quickForms = control.parameters['QuickForms'];
    const xml = isObj(quickForms) ? quickForms['xml'] : undefined;
    const ids = isObj(xml) ? xml['QuickFormIds'] : undefined;
    const entries = isObj(ids) ? ids['QuickFormId'] : undefined;
    const list = Array.isArray(entries) ? entries : entries === undefined ? [] : [entries];
    const out: Array<{ entity: string; formId?: string }> = [];
    for (const e of list) {
        if (!isObj(e) || !isObj(e['attributes'])) { continue; }
        const entity = e['attributes']['entityname'];
        if (typeof entity !== 'string' || !entity) { continue; }
        const formId = normaliseGuid(e['value']);
        out.push({ entity, formId: formId || undefined });
    }
    return out;
}

/**
 * The related record a quick view control shows for `record`: the id in its lookup's `_<field>_value`, and the quick view
 * form for the table that value is in (from the lookup's logical-name annotation, else the only/first form named).
 */
export function quickViewRecordRef(control: FormControl, record: Record<string, unknown>): QuickViewRef | undefined {
    if (!control.field) { return undefined; }
    const forms = quickViewForms(control);
    if (forms.length === 0) { return undefined; }
    const key = `_${control.field}_value`;
    const id = normaliseGuid(record[key]);
    if (!id) { return undefined; }
    const logicalName = record[`${key}${LOOKUP_LOGICAL_NAME}`];
    const form = typeof logicalName === 'string' && logicalName
        ? forms.find(f => f.entity === logicalName)
        : forms[0];
    if (!form) { return undefined; }
    return { entity: form.entity, id, ...(form.formId ? { formId: form.formId } : {}) };
}
