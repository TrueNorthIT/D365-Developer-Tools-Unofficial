import type { ViewModel } from '../form/formModel';
import { escapeHtml } from '../form/formRenderer';
import {
    columnLabel, columnSortDirection, describeFilter, describeSort, extractLinkEntities, extractSortOrders,
    LabelResolver, mapRows,
} from './viewQuery';

/**
 * Pure renderer for the `*.view.yml` previewer: ViewModel + labels + live-rows state → an HTML fragment.
 * No `vscode` import, no script, everything escaped. Reuses the form preview's look (FORM_CSS `.sg` grid) plus VIEW_CSS.
 */

/** What the grid body shows: nothing to fetch with, a fetch in flight, the fetched records, or the Dynamics error. */
export type RowsState =
    | { kind: 'signed-out' }
    | { kind: 'loading'; environment: string }
    | { kind: 'rows'; records: Array<Record<string, unknown>>; environment: string }
    | { kind: 'error'; message: string; environment: string };

export interface ViewPreviewInput {
    view: ViewModel;
    labels: LabelResolver;
    rows: RowsState;
    /** Non-fatal problems (missing table file, ...) shown as notices above the view. */
    warnings?: string[];
    /** The row cap the panel fetched with, so a full page can say it's only the first N. */
    maxRows?: number;
}

/** Default column width when the layout gives none (Dynamics uses 100px). */
const DEFAULT_WIDTH = 100;
const CHECKBOX_WIDTH = 44;

/** d365architect `queryType` → the view type Dynamics shows in the solution explorer. */
export function viewTypeLabel(queryType: string | undefined): string {
    switch ((queryType ?? '').toLowerCase()) {
        case '':
        case 'main':
        case 'mainapplicationview':
            return 'Public view';
        case 'subgrid':
        case 'associated':
            return 'Associated view';
        case 'lookupview':
            return 'Lookup view';
        case 'advancedsearch':
            return 'Advanced find view';
        case 'quickfindsearch':
            return 'Quick find view';
        default:
            return queryType!;
    }
}

function detail(label: string, value: string): string {
    return `<div class="vd-row"><span class="vd-label">${escapeHtml(label)}</span><span class="vd-val">${escapeHtml(value)}</span></div>`;
}

function rowsCaption(rows: RowsState, count: number, maxRows: number | undefined): string {
    switch (rows.kind) {
        case 'signed-out': return '';
        case 'loading': return `Loading rows from ${rows.environment}…`;
        case 'error': return `Query failed against ${rows.environment}`;
        case 'rows': {
            const first = maxRows !== undefined && count >= maxRows ? `First ${count} rows` : `${count} ${count === 1 ? 'row' : 'rows'}`;
            return `${first} from ${rows.environment}`;
        }
    }
}

export function renderViewHtml(input: ViewPreviewInput): string {
    const { view, labels, rows } = input;
    const fetchXml = view.fetchXml ?? '';
    const links = extractLinkEntities(fetchXml);
    const sorts = extractSortOrders(fetchXml);

    const notices = (input.warnings ?? []).map(w => `<div class="notice">${escapeHtml(w)}</div>`).join('');

    const tableName = labels.table?.displayName ?? view.entity;
    const type = viewTypeLabel(view.queryType) + (view.isDefault ? ' · Default' : '');
    const sortText = describeSort(sorts, links, labels);
    const filterText = describeFilter(fetchXml, labels);
    const head = '<div class="form-head view-head"><div class="head-row"><div class="head-title">'
        + `<div class="form-title"><h1 class="view-name">${escapeHtml(view.name)}</h1></div>`
        + '<div class="view-details">'
        + detail('Table', tableName)
        + detail('View type', type)
        + (sortText ? detail('Sorted by', sortText) : '')
        + (filterText ? detail('Filter', filterText) : '')
        + '</div></div></div></div>';

    // As in Dynamics, the table fills the panel and the layout widths (pixels) set each column's share of it; the
    // table never shrinks below those widths, so it scrolls sideways when the panel is narrower.
    const widths = view.columns.map(c => c.width ?? DEFAULT_WIDTH);
    const dataTotal = widths.reduce((sum, w) => sum + w, 0);
    const total = dataTotal + CHECKBOX_WIDTH;
    const cols = widths
        .map(w => `<col style="width:calc((100% - ${CHECKBOX_WIDTH}px) * ${+(w / dataTotal).toFixed(6)})">`).join('');
    const ths = view.columns.map(c => {
        const dir = columnSortDirection(c.name, sorts);
        const arrow = dir ? `<span class="sort-arrow">${dir === 'descending' ? '↓' : '↑'}</span>` : '';
        const ariaSort = dir ? ` aria-sort="${dir}"` : '';
        return `<th title="${escapeHtml(c.name)}"${ariaSort}>${escapeHtml(columnLabel(c.name, links, labels))}${arrow}</th>`;
    }).join('');

    const span = view.columns.length + 1;
    let body = '';
    let errorNotice = '';
    let count = 0;
    if (rows.kind === 'signed-out') {
        body = `<tr><td class="sg-msg" colspan="${span}">Sign in to Dynamics to load rows</td></tr>`;
    } else if (rows.kind === 'loading') {
        body = `<tr><td class="sg-msg" colspan="${span}">Loading…</td></tr>`;
    } else if (rows.kind === 'error') {
        errorNotice = `<div class="notice error view-error">${escapeHtml(rows.message)}</div>`;
    } else {
        const mapped = mapRows(rows.records, view.columns);
        count = mapped.length;
        body = mapped.length
            ? mapped.map(r => `<tr><td class="sg-chk"></td>${r.map(cell => `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
            : `<tr><td class="sg-msg" colspan="${span}">No rows match this view</td></tr>`;
    }
    const caption = rowsCaption(rows, count, input.maxRows);

    const grid = '<div class="section view-grid">'
        + errorNotice
        + '<div class="sg"><div class="sg-scroll">'
        + `<table style="min-width:${total}px"><colgroup><col style="width:${CHECKBOX_WIDTH}px">${cols}</colgroup>`
        + `<thead><tr><th class="sg-chk"></th>${ths}</tr></thead><tbody>${body}</tbody></table></div>`
        + (caption ? `<div class="sg-meta view-rows-meta">${escapeHtml(caption)}</div>` : '')
        + '</div></div>';

    return `<div class="d365-form d365-view">${notices}${head}${grid}</div>`;
}

/** View-specific additions to FORM_CSS. */
export const VIEW_CSS = `
.d365-view .view-head{padding-bottom:12px;margin-bottom:8px}
.d365-view .form-title h1.view-name{font-style:normal;color:var(--fg1)}
.d365-view .view-details{display:grid;grid-template-columns:max-content 1fr;column-gap:16px;row-gap:2px;padding-top:6px;font-size:13px}
.d365-view .vd-row{display:contents}
.d365-view .vd-label{color:var(--fg3)}
.d365-view .vd-val{color:var(--fg1);overflow-wrap:anywhere}
.d365-view .view-grid{padding:10px}
.d365-view .sg-scroll{overflow-x:auto}
.d365-view .sg table{table-layout:fixed}
.d365-view .sort-arrow{margin-left:4px;color:var(--fg3)}
.d365-view .sg td.sg-msg{height:84px;text-align:center;color:var(--fg3);font-style:italic;white-space:normal}
.d365-view .sg tbody tr:hover td.sg-msg{background:transparent}
.d365-view .view-error{white-space:pre-wrap}
`;
