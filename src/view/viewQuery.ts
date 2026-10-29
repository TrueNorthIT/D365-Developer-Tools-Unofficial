import type { TableModel, ViewColumn } from '../form/formModel';

/**
 * Pure logic for the `*.view.yml` previewer: reads sort orders, link-entities and filters out of FetchXML and turns
 * them into readable text, and maps Web API records onto grid rows. No `vscode` import.
 *
 * FetchXML is read with a small regex tokeniser (the repo has no XML parser). It is forgiving: malformed input gives
 * empty results rather than throwing, since the preview re-renders on every pause in typing.
 */

export interface SortOrder {
    attribute: string;
    descending: boolean;
    /** link-entity alias when the `<order>` sits inside a `<link-entity>`; absent for the root entity. */
    alias?: string;
}

export interface LinkEntityInfo {
    alias: string;
    /** Linked entity logical name (`name=`). */
    entity: string;
    /** Attribute on the primary entity the link joins from (`to=`), e.g. `parentcustomerid`. */
    to?: string;
}

export interface LabelResolver {
    /** Table for the view's own (root) entity. */
    table?: TableModel;
    /** Table for a linked entity, by logical name. */
    linkedTable?(entityLogicalName: string): TableModel | undefined;
}

// ── Tokeniser ───────────────────────────────────────────────────────────────

interface XmlNode {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    text: string;
    parent?: XmlNode;
}

const decodeXml = (s: string): string => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Builds an element tree from complete tags only; unclosed elements are closed at the end of input. */
function parseXml(xml: string): XmlNode {
    const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
    let current = root;
    const tag = /<(\/?)([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)>|([^<]+)/g;
    for (const m of xml.matchAll(tag)) {
        const [, closing, name, rawAttrs, selfClosing, text] = m;
        if (text !== undefined) { current.text += decodeXml(text); continue; }
        if (!name) { continue; }
        if (closing) {
            // Pop to the matching open element; a stray close tag is ignored.
            for (let n: XmlNode | undefined = current; n && n !== root; n = n.parent) {
                if (n.name === name) { current = n.parent ?? root; break; }
            }
            continue;
        }
        const attrs: Record<string, string> = {};
        for (const a of (rawAttrs ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? '');
        }
        const node: XmlNode = { name, attrs, children: [], text: '', parent: current };
        current.children.push(node);
        if (!selfClosing) { current = node; }
    }
    return root;
}

function* walk(node: XmlNode): Generator<XmlNode> {
    for (const child of node.children) {
        yield child;
        yield* walk(child);
    }
}

/** The nearest enclosing `<link-entity>`, if any. */
function enclosingLink(node: XmlNode): XmlNode | undefined {
    for (let n = node.parent; n; n = n.parent) {
        if (n.name === 'link-entity') { return n; }
    }
    return undefined;
}

// ── Sort orders and link-entities ────────────────────────────────────────────

export function extractSortOrders(fetchXml: string): SortOrder[] {
    const sorts: SortOrder[] = [];
    for (const node of walk(parseXml(fetchXml))) {
        if (node.name !== 'order' || !node.attrs.attribute) { continue; }
        const alias = enclosingLink(node)?.attrs.alias;
        sorts.push({
            attribute: node.attrs.attribute,
            descending: node.attrs.descending === 'true',
            ...(alias ? { alias } : {}),
        });
    }
    return sorts;
}

export function extractLinkEntities(fetchXml: string): LinkEntityInfo[] {
    const links: LinkEntityInfo[] = [];
    for (const node of walk(parseXml(fetchXml))) {
        const { alias, name, to } = node.attrs;
        if (node.name !== 'link-entity' || !alias || !name) { continue; }
        links.push({ alias, entity: name, ...(to ? { to } : {}) });
    }
    return links;
}

// ── Labels ──────────────────────────────────────────────────────────────────

const displayName = (table: TableModel | undefined, attribute: string): string =>
    table?.attributes.get(attribute)?.displayName ?? attribute;

/**
 * Header text for a layout column: the root table's display name, or for an `alias.attribute` column
 * "<linked display name> (<lookup display name>)", e.g. "Account Name (Parent Customer)".
 */
export function columnLabel(columnName: string, links: LinkEntityInfo[], labels: LabelResolver): string {
    const dot = columnName.indexOf('.');
    if (dot < 0) { return displayName(labels.table, columnName); }
    const alias = columnName.slice(0, dot);
    const attribute = columnName.slice(dot + 1);
    const link = links.find(l => l.alias === alias);
    if (!link) { return columnName; }
    const linkedTable = labels.linkedTable?.(link.entity);
    const via = link.to ? displayName(labels.table, link.to) : (linkedTable?.displayName ?? link.entity);
    return `${displayName(linkedTable, attribute)} (${via})`;
}

export function columnSortDirection(columnName: string, sorts: SortOrder[]): 'ascending' | 'descending' | undefined {
    const dot = columnName.indexOf('.');
    const alias = dot < 0 ? undefined : columnName.slice(0, dot);
    const attribute = dot < 0 ? columnName : columnName.slice(dot + 1);
    const sort = sorts.find(s => s.attribute === attribute && s.alias === alias);
    return sort ? (sort.descending ? 'descending' : 'ascending') : undefined;
}

/** "Created On (descending), Full Name (ascending)", in priority order; undefined for an unsorted view. */
export function describeSort(sorts: SortOrder[], links: LinkEntityInfo[], labels: LabelResolver): string | undefined {
    if (sorts.length === 0) { return undefined; }
    return sorts
        .map(s => `${columnLabel(s.alias ? `${s.alias}.${s.attribute}` : s.attribute, links, labels)} (${s.descending ? 'descending' : 'ascending'})`)
        .join(', ');
}

// ── Filters ─────────────────────────────────────────────────────────────────

/** Operators whose condition reads "<label> <words> <value>". */
const VALUE_OPERATORS: Record<string, string> = {
    'eq': 'equals',
    'ne': 'does not equal',
    'neq': 'does not equal',
    'gt': 'is greater than',
    'ge': 'is greater than or equal to',
    'lt': 'is less than',
    'le': 'is less than or equal to',
    'on': 'on',
    'on-or-after': 'on or after',
    'on-or-before': 'on or before',
    'begins-with': 'begins with',
    'not-begin-with': 'does not begin with',
    'ends-with': 'ends with',
    'not-end-with': 'does not end with',
    'in': 'is one of',
    'not-in': 'is not one of',
};

/** Operators that take no value. */
const NO_VALUE_OPERATORS: Record<string, string> = {
    'null': 'does not contain data',
    'not-null': 'contains data',
    'eq-userid': 'equals current user',
    'ne-userid': 'does not equal current user',
    'eq-businessid': 'equals current business unit',
    'ne-businessid': 'does not equal current business unit',
    'today': 'is today',
    'yesterday': 'is yesterday',
    'tomorrow': 'is tomorrow',
    'this-week': 'is this week',
    'this-month': 'is this month',
    'this-year': 'is this year',
    'last-week': 'is last week',
    'last-month': 'is last month',
    'last-year': 'is last year',
    'next-week': 'is next week',
    'next-month': 'is next month',
    'next-year': 'is next year',
};

interface Described {
    text: string;
    /** Number of conditions/groups joined at this level (1 = a single condition, never needs brackets). */
    parts: number;
    op: 'AND' | 'OR';
}

interface FilterScope {
    links: Map<string, string>;
    labels: LabelResolver;
}

function describeCondition(node: XmlNode, table: TableModel | undefined): string | undefined {
    const attribute = node.attrs.attribute;
    const operator = node.attrs.operator;
    if (!attribute || !operator) { return undefined; }
    const attr = table?.attributes.get(attribute);
    const label = attr?.displayName ?? attribute;
    const raw = node.attrs.value !== undefined
        ? [node.attrs.value]
        : node.children.filter(c => c.name === 'value').map(c => c.text.trim());
    // Choice values show their label when the table knows it (REQ-8); anything else stays as written.
    const values = raw.map(v => {
        const n = Number(v);
        return v !== '' && Number.isFinite(n) ? (attr?.options?.get(n) ?? v) : v;
    });
    const value = values.join(', ');

    if (operator === 'like' || operator === 'not-like') {
        // `%x%` / `x%` / `%x` are how the Dynamics filter editor stores contains / begins with / ends with.
        const v = raw[0] ?? '';
        const negated = operator === 'not-like';
        const leading = v.length > 1 && v.startsWith('%');
        const trailing = v.length > 1 && v.endsWith('%');
        const bare = v.replace(/^%|%$/g, '');
        if (leading && trailing) { return `${label} ${negated ? 'does not contain' : 'contains'} ${bare}`; }
        if (trailing) { return `${label} ${negated ? 'does not begin with' : 'begins with'} ${bare}`; }
        if (leading) { return `${label} ${negated ? 'does not end with' : 'ends with'} ${bare}`; }
        return `${label} ${operator} ${v}`;
    }
    const xDays = /^(last|next)-x-(hours|days|weeks|months|years)$/.exec(operator);
    if (xDays) { return `${label} in the ${xDays[1]} ${value} ${xDays[2]}`; }
    if (VALUE_OPERATORS[operator]) { return `${label} ${VALUE_OPERATORS[operator]} ${value}`; }
    if (NO_VALUE_OPERATORS[operator]) { return `${label} ${NO_VALUE_OPERATORS[operator]}`; }
    // Unrecognised operator (REQ-9): show it raw rather than hide the condition.
    return value ? `${label} ${operator} ${value}` : `${label} ${operator}`;
}

/** Table a condition's attribute belongs to: its `entityname=` alias, else the link-entity it sits in, else the root. */
function tableFor(node: XmlNode, scope: FilterScope): TableModel | undefined {
    const alias = node.attrs.entityname ?? enclosingLink(node)?.attrs.alias;
    const linkName = alias ? scope.links.get(alias) : enclosingLink(node)?.attrs.name;
    return linkName ? scope.labels.linkedTable?.(linkName) : scope.labels.table;
}

function describeGroup(filter: XmlNode, scope: FilterScope): Described | undefined {
    const op = filter.attrs.type === 'or' ? 'OR' : 'AND';
    const parts: string[] = [];
    for (const child of filter.children) {
        if (child.name === 'condition') {
            const text = describeCondition(child, tableFor(child, scope));
            if (text) { parts.push(text); }
        } else if (child.name === 'filter') {
            const inner = describeGroup(child, scope);
            if (inner) { parts.push(inner.parts > 1 && inner.op !== op ? `(${inner.text})` : inner.text); }
        }
    }
    if (parts.length === 0) { return undefined; }
    if (parts.length === 1) {
        // A group holding a single nested group takes that group's operator, so the parent brackets it correctly.
        const only = filter.children.find(c => c.name === 'filter' || c.name === 'condition');
        if (only?.name === 'filter') { return describeGroup(only, scope); }
    }
    return { text: parts.join(` ${op} `), parts: parts.length, op };
}

/**
 * Plain-English filter: the root entity's filters, then each link-entity's filters, joined by AND.
 * Undefined when the view has no (readable) filter.
 */
export function describeFilter(fetchXml: string, labels: LabelResolver): string | undefined {
    const root = parseXml(fetchXml);
    const links = new Map(extractLinkEntities(fetchXml).map(l => [l.alias, l.entity]));
    const scope: FilterScope = { links, labels };

    // Top-level filters: those directly under <entity> or a <link-entity> (nested filters are handled by describeGroup).
    const groups: Described[] = [];
    const entityFilters: XmlNode[] = [];
    const linkFilters: XmlNode[] = [];
    for (const node of walk(root)) {
        if (node.name !== 'filter' || !node.parent) { continue; }
        if (node.parent.name === 'entity') { entityFilters.push(node); }
        if (node.parent.name === 'link-entity') { linkFilters.push(node); }
    }
    for (const filter of [...entityFilters, ...linkFilters]) {
        const g = describeGroup(filter, scope);
        if (g) { groups.push(g); }
    }
    if (groups.length === 0) { return undefined; }
    if (groups.length === 1) { return groups[0].text; }
    return groups.map(g => (g.parts > 1 && g.op === 'OR' ? `(${g.text})` : g.text)).join(' AND ');
}

// ── Rows ────────────────────────────────────────────────────────────────────

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

/**
 * Maps Web API records (from a FetchXML query with formatted-value annotations) onto grid rows in layout column order.
 * Prefers the formatted value; lookups are read from `_<name>_value`, linked columns from `alias.attribute`.
 */
export function mapRows(records: Array<Record<string, unknown>>, columns: ViewColumn[]): string[][] {
    return records.map(record => columns.map(column => {
        const keys = column.name.includes('.') ? [column.name] : [column.name, `_${column.name}_value`];
        for (const key of keys) {
            const formatted = record[`${key}${FORMATTED}`];
            if (typeof formatted === 'string') { return formatted; }
            const raw = record[key];
            if (raw !== undefined && raw !== null) { return typeof raw === 'object' ? JSON.stringify(raw) : String(raw); }
        }
        return '';
    }));
}

/**
 * Pulls the human-readable message out of a DataverseClient error (`Dataverse API error 400: {"error":{"message":…}}`),
 * falling back to the text as given.
 */
export function dataverseErrorMessage(message: string): string {
    const json = message.indexOf('{');
    if (json >= 0) {
        try {
            const body = JSON.parse(message.slice(json)) as { error?: { message?: unknown } };
            if (typeof body.error?.message === 'string' && body.error.message) { return body.error.message; }
        } catch {
            // Not JSON after all: fall through.
        }
    }
    return message;
}
