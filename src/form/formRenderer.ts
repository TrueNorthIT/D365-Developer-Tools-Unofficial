import {
    FormControl, FormModel, FormSection, FormTab, TableAttribute, TableModel, ViewModel,
} from './formModel';
import { FieldDisplay, fieldDisplay } from './recordPreview';
import { mapRows } from '../view/viewQuery';

/**
 * Pure renderer: FormModel (+ optional TableModel for labels/types/required levels)
 * → an HTML fragment. No `vscode` import, no script, everything escaped.
 */

export type WidgetKind =
    | 'text' | 'email' | 'url' | 'phone' | 'multiline' | 'number' | 'decimal' | 'currency'
    | 'date' | 'datetime' | 'optionset' | 'multiselect' | 'twooptions' | 'toggle' | 'checkbox'
    | 'lookup' | 'partylist'
    | 'subgrid' | 'notes' | 'timeline' | 'quickview' | 'iframe' | 'webresource' | 'activities' | 'custom';

const PLACEHOLDER_KINDS = new Set<WidgetKind>([
    'subgrid', 'notes', 'timeline', 'quickview', 'iframe', 'webresource', 'activities', 'custom',
]);

const CONTROL_KIND: Record<string, WidgetKind> = {
    SingleLineText: 'text', TickerSymbol: 'text', Email: 'email', Url: 'url', Phone: 'phone',
    MultilineText: 'multiline', WholeNumber: 'number', Decimal: 'decimal', Currency: 'currency',
    DateAndTime: 'datetime', OptionSet: 'optionset', MultiSelectOptionSet: 'multiselect',
    TwoOptions: 'twooptions', TwoOptionsCheckbox: 'checkbox', Lookup: 'lookup', PartyList: 'partylist',
    Subgrid: 'subgrid', Notes: 'notes', Timeline: 'timeline', QuickViewForm: 'quickview',
    IFrame: 'iframe', WebResource: 'webresource', WebResourceImage: 'webresource',
    WebResourceSilverlight: 'webresource', ActivitiesGrid: 'activities',
};

function kindFromAttribute(attr: TableAttribute): WidgetKind | undefined {
    switch (attr.type) {
        case 'Lookup': case 'Customer': case 'Owner': return 'lookup';
        case 'Picklist': case 'State': case 'Status': return 'optionset';
        case 'MultiSelectPicklist': return 'multiselect';
        case 'Boolean': return 'twooptions';
        case 'DateTime': return attr.format === 'DateOnly' ? 'date' : 'datetime';
        case 'Memo': return 'multiline';
        case 'Integer': case 'BigInt': return 'number';
        case 'Decimal': case 'Double': return 'decimal';
        case 'Money': return 'currency';
        case 'String':
            if (attr.format === 'Email') { return 'email'; }
            if (attr.format === 'Url') { return 'url'; }
            if (attr.format === 'Phone') { return 'phone'; }
            return 'text';
        default: return undefined;
    }
}

/** Placeholder controls come from the YAML control type; fields prefer the table's real attribute type. */
export function resolveKind(control: FormControl, attr?: TableAttribute): WidgetKind {
    if (control.customControlId && !control.field && !control.control) {
        // The Power Apps grid control replaces a classic subgrid but is exported without a `control` type; it's
        // identified by its web control name. Other unbound controls (SLA timer, calendar, ...) also carry
        // subgrid-style parameters, so the parameters alone can't tell them apart.
        const p = control.parameters;
        const isGrid = /PowerAppsOneGrid|GridControl/.test(control.webControlName ?? '');
        const hasNoName = !control.webControlName;
        if (isGrid || (hasNoName && typeof p['TargetEntityType'] === 'string' && (p['ViewId'] || p['RelationshipName']))) {
            return 'subgrid';
        }
        // Any other PCF with no bound field has nothing to show but its presence.
        return 'custom';
    }
    // A Two Options field is a dropdown by default; it is a toggle only when the form swaps in the toggle control.
    if (control.field && /ToggleControl/.test(control.webControlName ?? '')) { return 'toggle'; }
    const declared = control.control ? CONTROL_KIND[control.control] : undefined;
    if (declared && PLACEHOLDER_KINDS.has(declared)) { return declared; }
    if (attr) {
        const fromAttr = kindFromAttribute(attr);
        if (fromAttr) { return fromAttr; }
    }
    return declared ?? 'text';
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Outline icons (16px, stroke = currentColor) standing in for the client's Fluent icon font. Chevron, search, calendar
 * and the toggle/date shapes follow the real controls; mail/link/phone/clock are approximations of the same family.
 */
const SVG = (inner: string) =>
    `<span class="ico"><svg viewBox="0 0 16 16" aria-hidden="true">${inner}</svg></span>`;
export const ICON = {
    chevron: SVG('<polyline points="3.5,6 8,10.5 12.5,6"/>'),
    search: SVG('<circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/>'),
    calendar: SVG('<rect x="2" y="3" width="12" height="11" rx="1.5"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="5.5" y1="1.5" x2="5.5" y2="4"/><line x1="10.5" y1="1.5" x2="10.5" y2="4"/>'),
    clock: SVG('<circle cx="8" cy="8" r="6"/><polyline points="8,4.5 8,8 10.5,9.5"/>'),
    mail: SVG('<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><polyline points="2.5,4.5 8,9 13.5,4.5"/>'),
    link: SVG('<path d="M7 4H4.5A1.5 1.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13h6a1.5 1.5 0 0 0 1.5-1.5V9"/><polyline points="9,3 13,3 13,7"/><line x1="13" y1="3" x2="7.5" y2="8.5"/>'),
    phone: SVG('<path d="M4 2.5h2l1 3-1.5 1a7 7 0 0 0 3 3l1-1.5 3 1v2a1.5 1.5 0 0 1-1.5 1.5A9.5 9.5 0 0 1 2.5 4 1.5 1.5 0 0 1 4 2.5z"/>'),
};
const KIND_ICON: Partial<Record<WidgetKind, string>> = {
    lookup: ICON.search, partylist: ICON.search,
    optionset: ICON.chevron, multiselect: ICON.chevron, twooptions: ICON.chevron,
    date: ICON.calendar, email: ICON.mail, url: ICON.link, phone: ICON.phone,
};

const DATE_PLACEHOLDER = 'dd/MM/yyyy';
const TIME_PLACEHOLDER = 'hh:mm';

const KIND_LABEL: Record<string, string> = {
    subgrid: 'Subgrid', notes: 'Notes', timeline: 'Timeline', quickview: 'Quick view form',
    iframe: 'IFrame', webresource: 'Web resource', activities: 'Activities', custom: 'Custom control',
};

function safeWidth(width: string): number {
    const n = parseFloat(width);
    return Number.isFinite(n) && n > 0 ? n : 100;
}

/** Where a subgrid's view came from: the d365architect export on disk, or fetched live from Dynamics. */
export type ViewOrigin = 'export' | 'dynamics';

/**
 * Supplies subgrid views and the tables that label their columns. Both lookups are synchronous reads of whatever is
 * available right now (export on disk, then a Dynamics cache); an unavailable view is simply `view: undefined` and the
 * preview renders a blank grid. Implemented by FormSubgridSource.
 */
export interface SubgridSource {
    resolveView(entity: string, viewId: string | undefined): { view?: ViewModel; origin?: ViewOrigin };
    loadTable(entity: string): TableModel | undefined;
}

/** Related rows for one subgrid when a record is selected: loading, the rows, or Dynamics' error. */
export type RelatedRows =
    | { kind: 'loading' }
    | { kind: 'rows'; records: Array<Record<string, unknown>> }
    | { kind: 'error'; message: string };

/** What a quick view control shows when a record is selected. */
export interface QuickViewContent {
    /** The quick view form's own layout (from the export) and the table that labels it. */
    form?: { model: FormModel; table?: TableModel };
    /** The related record; absent while loading, on error, or when the lookup is empty (a blank quick view). */
    record?: Record<string, unknown>;
    loading?: boolean;
    error?: string;
    /** Why the quick view can't be shown (it stays a placeholder), or a remark under it. */
    note?: string;
}

/**
 * A live record selected in the previewer (read-only): its values fill the fields, its primary name is the title, and the
 * callbacks supply each subgrid's related rows and each quick view's related record (fetched in the background by
 * FormRecordSource; synchronous reads of whatever has arrived).
 */
export interface RecordView {
    record: Record<string, unknown>;
    title: string;
    /** e.g. "Active - Saved"; empty when the record has no state. */
    status: string;
    subgridRows?(control: FormControl, view: ViewModel): RelatedRows;
    quickView?(control: FormControl): QuickViewContent;
}

interface Ctx {
    table?: TableModel;
    subgrids?: SubgridSource;
    /** Values that fill the fields (the selected record, or a quick view's related record); absent = an empty preview. */
    values?: Record<string, unknown>;
    record?: RecordView;
}

/** The shown record's display value for a control; undefined when no record is shown. */
function valueFor(control: FormControl, ctx: Ctx, attr?: TableAttribute): FieldDisplay | undefined {
    if (!ctx.values) { return undefined; }
    return control.field ? fieldDisplay(ctx.values, control.field, attr) : { text: '---', kind: 'empty' };
}

function attrFor(control: FormControl, ctx: Ctx): TableAttribute | undefined {
    return control.field ? ctx.table?.attributes.get(control.field) : undefined;
}

function labelFor(control: FormControl, attr?: TableAttribute): string {
    return control.label ?? attr?.displayName ?? control.field ?? control.id ?? '';
}

function requirementMark(control: FormControl, attr?: TableAttribute): string {
    if (control.isRequired || attr?.requiredLevel === 'ApplicationRequired') {
        return '<span class="req" title="Business required">*</span>';
    }
    if (attr?.requiredLevel === 'Recommended') {
        return '<span class="rec" title="Business recommended">+</span>';
    }
    return '';
}

const SUBGRID_PREVIEW_ROWS = 3;

function columnLabel(name: string, view: ViewModel, ctx: Ctx, target: TableModel | undefined): string {
    const dot = name.indexOf('.');
    if (dot < 0) { return target?.attributes.get(name)?.displayName ?? name; }
    const alias = name.slice(0, dot);
    const attr = name.slice(dot + 1);
    const linked = view.linkEntities.get(alias);
    const linkedTable = linked ? ctx.subgrids?.loadTable(linked) : undefined;
    return linkedTable?.attributes.get(attr)?.displayName ?? attr;
}

function renderSubgrid(control: FormControl, ctx: Ctx): string | undefined {
    const target = control.parameters['TargetEntityType'];
    if (!ctx.subgrids || typeof target !== 'string' || !target) { return undefined; }
    const viewId = typeof control.parameters['ViewId'] === 'string' ? control.parameters['ViewId'] : undefined;
    const { view, origin } = ctx.subgrids.resolveView(target, viewId);
    const targetTable = ctx.subgrids.loadTable(target);

    const label = control.label && control.showLabel ? `<div class="sg-title">${escapeHtml(control.label)}</div>` : '';
    const entityName = targetTable?.displayName ?? target;
    // Toolbar mirrors the real subgrid command bar (New / Refresh / Flow / Run Report) and keyword filter.
    const cmd = '<div class="sg-cmd">'
        + `<span class="sg-btn">+ New ${escapeHtml(entityName)}</span><span class="sg-btn">Refresh</span>`
        + '<span class="sg-btn">Flow</span><span class="sg-btn">Run Report</span>'
        + '<span class="sg-search">Filter by keyword ${ICON.search}</span></div>';

    // No view anywhere (not exported, and not fetched from Dynamics): leave the grid blank rather than guess its columns.
    if (!view || view.columns.length === 0) {
        const why = viewId ? `View ${escapeHtml(viewId)} isn't in the export and couldn't be fetched from Dynamics.` : 'This subgrid has no view id.';
        return `<div class="sg sg-blank ph-subgrid" data-view-origin="none">${label}${cmd}<div class="sg-empty"></div>`
            + `<div class="sg-note">${why}</div></div>`;
    }

    const viewIds = control.parameters['ViewIds'];
    const hasPicker = typeof viewIds === 'string' && viewIds.includes(',');
    const total = view.columns.reduce((sum, c) => sum + (c.width ?? 100), 0) || 1;
    const cols = view.columns.map(c => `<col style="width:${(((c.width ?? 100) / total) * 100).toFixed(2)}%">`).join('');
    const head = view.columns.map(c => `<th title="${escapeHtml(c.name)}">${escapeHtml(columnLabel(c.name, view, ctx, targetTable))}</th>`).join('');
    const span = view.columns.length + 1;
    const message = (text: string) => `<tr><td class="sg-msg" colspan="${span}">${escapeHtml(text)}</td></tr>`;

    let body = `<tr><td class="sg-chk"></td>${view.columns.map(() => '<td>---</td>').join('')}</tr>`.repeat(SUBGRID_PREVIEW_ROWS);
    let note = '';
    let rowsState = '';
    if (ctx.record) {
        // A record is selected: show its related rows, never the view's unfiltered rows.
        const relationship = control.parameters['RelationshipName'];
        if (typeof relationship !== 'string' || !relationship || !ctx.record.subgridRows) {
            body = '';
            rowsState = ' data-rows="none"';
            note = '<div class="sg-note">This subgrid has no relationship, so its rows can\'t be tied to this record.</div>';
        } else {
            const rows = ctx.record.subgridRows(control, view);
            rowsState = ` data-rows="${rows.kind}"`;
            if (rows.kind === 'loading') {
                body = message('Loading…');
            } else if (rows.kind === 'error') {
                body = '';
                note = `<div class="sg-note sg-error">${escapeHtml(rows.message)}</div>`;
            } else {
                const mapped = mapRows(rows.records, view.columns);
                body = mapped.length
                    ? mapped.map(r => `<tr><td class="sg-chk"></td>${r.map(cell => `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
                    : message('No data available.');
            }
        }
    }
    // Preview-only annotation (not part of the real UI): which view the columns came from, and where it was found.
    const meta = `<div class="sg-meta">View: ${escapeHtml(view.name)}${hasPicker ? ' ▾' : ''} · ${escapeHtml(target)} · ${origin === 'dynamics' ? 'from Dynamics' : 'from export'}</div>`;
    return `<div class="sg ph-subgrid" data-view-origin="${origin ?? 'export'}"${rowsState}>${label}${cmd}`
        + `<table><colgroup><col style="width:44px">${cols}</colgroup><thead><tr><th class="sg-chk"></th>${head}</tr></thead>`
        + `<tbody>${body}</tbody></table>`
        + (body ? '' : '<div class="sg-empty-rows"></div>')
        + note + meta + '</div>';
}

function renderPlaceholder(kind: WidgetKind, control: FormControl, ctx: Ctx): string {
    if (kind === 'custom') {
        const title = control.label ?? control.webControlName?.split('.').slice(-1)[0] ?? 'Custom control';
        const detail = control.webControlName ? `Custom control · ${control.webControlName}` : 'Custom control';
        return `<div class="ph ph-custom"><div class="ph-title">${escapeHtml(title)}</div><div class="ph-detail">${escapeHtml(detail)}</div></div>`;
    }
    if (kind === 'subgrid') {
        const real = renderSubgrid(control, ctx);
        if (real) { return real; }
    }
    let quickViewNote = '';
    if (kind === 'quickview' && ctx.record?.quickView) {
        const content = ctx.record.quickView(control);
        if (content.form) { return renderQuickView(control, content, ctx); }
        if (content.note) { quickViewNote = `<div class="sg-note">${escapeHtml(content.note)}</div>`; }
    }
    const title = KIND_LABEL[kind] ?? kind;
    const target = control.parameters['TargetEntityType'];
    const rel = control.parameters['RelationshipName'];
    const detail = [typeof target === 'string' ? target : '', typeof rel === 'string' ? rel : '']
        .filter(Boolean).join(' · ');
    const grid = kind === 'subgrid' || kind === 'activities'
        ? '<div class="ph-grid"><div></div><div></div><div></div></div><div class="ph-grid"><div></div><div></div><div></div></div>'
        : '';
    return `<div class="ph ph-${kind}"><div class="ph-title">${escapeHtml(title)}</div>`
        + (detail ? `<div class="ph-detail">${escapeHtml(detail)}</div>` : '')
        + grid + quickViewNote + '</div>';
}

/**
 * A quick view form as Dynamics shows it: a read-only block (no tab strip) of the quick view's sections, filled from the
 * related record. An empty lookup shows the layout blank.
 */
function renderQuickView(control: FormControl, content: QuickViewContent, ctx: Ctx): string {
    const { model, table } = content.form!;
    const inner: Ctx = { table, subgrids: ctx.subgrids, values: content.record ?? {} };
    const sections = model.tabs.filter(t => t.visible)
        .flatMap(t => t.columns.flatMap(c => c.sections))
        .map(s => renderSection(s, inner))
        .join('');
    const title = control.showLabel && control.label ? `<div class="qv-title">${escapeHtml(control.label)}</div>` : '';
    const status = content.error
        ? `<div class="sg-note sg-error">${escapeHtml(content.error)}</div>`
        : content.loading ? '<div class="qv-msg">Loading…</div>' : '';
    const note = content.note ? `<div class="sg-note">${escapeHtml(content.note)}</div>` : '';
    return `<div class="qv" data-quick-view="${escapeHtml(model.formId ?? '')}">${title}${sections}${status}${note}</div>`;
}

function renderInput(kind: WidgetKind, control: FormControl, value?: FieldDisplay, raw?: unknown): string {
    const cls = ['input', `k-${kind}`, control.disabled ? 'ro' : '', value ? 'filled' : ''].filter(Boolean).join(' ');
    const val = (text: string, extra = '') => `<span class="val${extra}">${text}</span>`;
    let inner: string;
    if (value) {
        // A selected record's value (read-only). Lookups are links; empty values read "---" as in Dynamics.
        const text = escapeHtml(value.text);
        const shown = val(text, value.kind === 'link' ? ' link' : value.kind === 'empty' ? ' empty' : '');
        switch (kind) {
            case 'toggle':
                inner = `<span class="sw${raw === true ? ' on' : ''}"></span><span class="sw-label">${value.kind === 'empty' ? 'No' : text}</span>`;
                break;
            case 'checkbox':
                inner = `<span class="cb${raw === true ? ' on' : ''}"></span>`;
                break;
            case 'datetime': {
                // Dynamics formats a date and time as "dd/MM/yyyy HH:mm": split it across the two inputs.
                const cut = value.kind === 'text' ? value.text.lastIndexOf(' ') : -1;
                const date = cut > 0 ? value.text.slice(0, cut) : value.text;
                const time = cut > 0 ? value.text.slice(cut + 1) : '';
                inner = `<span class="dt dt-date">${val(escapeHtml(date), value.kind === 'empty' ? ' empty' : '')}${ICON.calendar}</span>`
                    + `<span class="dt dt-time">${time ? val(escapeHtml(time)) : val('---', ' empty')}${ICON.clock}</span>`;
                break;
            }
            default:
                inner = shown + (kind === 'date' ? ICON.calendar : (KIND_ICON[kind] ?? ''));
        }
        return `<div class="${cls}">${inner}</div>`;
    }
    switch (kind) {
        case 'toggle':
            // Fluent Switch (40x20 pill) with its Yes/No label; empty preview shows the "off" state.
            inner = '<span class="sw"></span><span class="sw-label">No</span>';
            break;
        case 'checkbox':
            inner = '<span class="cb"></span>';
            break;
        case 'date':
            // The real date control is a text input whose empty state is the format placeholder, plus a calendar button.
            inner = val(DATE_PLACEHOLDER, ' ph-text') + ICON.calendar;
            break;
        case 'datetime':
            inner = `<span class="dt dt-date">${val(DATE_PLACEHOLDER, ' ph-text')}${ICON.calendar}</span>`
                + `<span class="dt dt-time">${val(TIME_PLACEHOLDER, ' ph-text')}${ICON.clock}</span>`;
            break;
        default:
            inner = val('---') + (KIND_ICON[kind] ?? '');
    }
    return `<div class="${cls}">${inner}</div>`;
}

function renderControl(control: FormControl, ctx: Ctx): string {
    if (!control.visible) { return ''; }
    const attr = attrFor(control, ctx);
    const kind = resolveKind(control, attr);
    const placeholder = PLACEHOLDER_KINDS.has(kind);
    const label = labelFor(control, attr);
    const showLabel = control.showLabel && !placeholder && label !== '';

    const style: string[] = [];
    if (control.columnSpan > 1) { style.push(`grid-column:span ${control.columnSpan}`); }
    if (control.rowSpan > 1) { style.push(`grid-row:span ${control.rowSpan}`); }
    const rows = control.rowSpan > 1 ? ` rows-${Math.min(control.rowSpan, 20)}` : '';
    const attrs = ` data-field="${escapeHtml(control.field ?? '')}"`;

    const labelHtml = showLabel
        ? `<div class="label" title="${escapeHtml(control.field ?? '')}"><span class="label-text">${escapeHtml(label)}</span>${requirementMark(control, attr)}</div>`
        : '';
    const body = placeholder
        ? renderPlaceholder(kind, control, ctx)
        : renderInput(kind, control, valueFor(control, ctx, attr), control.field ? ctx.values?.[control.field] : undefined);
    const unresolved = ctx.table && control.field && !attr ? ' unresolved' : '';
    return `<div class="field${showLabel ? '' : ' nolabel'}${rows}${unresolved}"${attrs}`
        + (style.length ? ` style="${style.join(';')}"` : '') + `>${labelHtml}${body}</div>`;
}

function renderSection(section: FormSection, ctx: Ctx): string {
    if (!section.visible) { return ''; }
    const rendered = section.controls.map(c => renderControl(c, ctx));
    if (!rendered.some(Boolean)) { return ''; }
    const title = section.showLabel && section.label
        ? `<h3 class="section-title">${escapeHtml(section.label)}</h3>`
        : '';
    const n = section.columns;
    // The real client deals controls (in YAML order, hidden ones included) into independent vertical
    // column stacks: control i goes to column i % n, so a tall field never pushes its neighbour down.
    // Spans can't be expressed that way, so sections that use them fall back to a CSS grid.
    const spans = section.controls.some(c => c.columnSpan > 1 || c.rowSpan > 1);
    if (n > 1 && !spans) {
        const stacks = Array.from({ length: n }, (_, col) =>
            `<div class="col" style="width:${(100 / n).toFixed(2)}%">${rendered.filter((_h, i) => i % n === col).join('')}</div>`);
        return `<section class="section">${title}<div class="cols" data-n="${n}">${stacks.join('')}</div></section>`;
    }
    return `<section class="section">${title}<div class="grid" data-n="${n}" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${rendered.join('')}</div></section>`;
}

function renderTabPanel(tab: FormTab, index: number, ctx: Ctx): string {
    const total = tab.columns.reduce((sum, c) => sum + safeWidth(c.width), 0) || 100;
    const weights = tab.columns.map(col => `${((safeWidth(col.width) / total) * 100).toFixed(2)}fr`).join(' ');
    const cols = tab.columns.map(col => `<div class="tab-col">${col.sections.map(s => renderSection(s, ctx)).join('')}</div>`).join('');
    return `<div class="tab-panel${index === 0 ? ' active' : ''}" role="tabpanel" data-tab-panel="${index}">`
        + `<div class="tab-body" style="grid-template-columns:${weights}">${cols}</div></div>`;
}

function tabTitle(tab: FormTab): string {
    return tab.label ?? tab.name ?? '';
}

/** Footer fields: a plain strip of label/value pairs at the bottom of the form. */
function renderFooterStrip(controls: FormControl[], ctx: Ctx): string {
    const items = controls.filter(c => c.visible).map(c => {
        const attr = attrFor(c, ctx);
        const value = valueFor(c, ctx, attr);
        const link = value?.kind === 'link' ? ' link' : '';
        return `<div class="strip-item"><div class="strip-label">${escapeHtml(labelFor(c, attr))}</div><div class="strip-val${link}">${escapeHtml(value?.text ?? '---')}</div></div>`;
    }).join('');
    return items ? `<div class="strip footer">${items}</div>` : '';
}

/**
 * Header fields, as the real client shows them inside the header card: each is a bold value with its
 * 12px label underneath, separated by thin vertical dividers. Lookups render as links.
 */
function renderHeaderFields(controls: FormControl[], ctx: Ctx): string {
    const items = controls.filter(c => c.visible).map(c => {
        const attr = attrFor(c, ctx);
        const value = valueFor(c, ctx, attr);
        const link = (value ? value.kind === 'link' : resolveKind(c, attr) === 'lookup') ? ' link' : '';
        return `<div class="hf"><div class="hf-val${link}">${escapeHtml(value?.text ?? '---')}</div><div class="hf-label">${escapeHtml(labelFor(c, attr))}</div></div>`;
    });
    return items.length ? `<div class="head-fields">${items.join('<div class="hf-divider"></div>')}</div>` : '';
}

/**
 * Renders the form. With `record` (a live record picked in the previewer) fields show its values, the title its name and
 * status, subgrids its related rows and quick views its related record; without one the form is an empty preview.
 */
export function renderFormHtml(
    model: FormModel, table?: TableModel, warnings: string[] = [], subgrids?: SubgridSource, record?: RecordView,
): string {
    const ctx: Ctx = { table, subgrids, values: record?.record, record };
    const notices = warnings.map(w => `<div class="notice">${escapeHtml(w)}</div>`).join('');
    const entityName = table?.displayName ?? model.entity;
    const tabs = model.tabs.filter(t => t.visible);
    // Quick Create / Card / Quick View forms have no tab strip (or header fields) in the real client.
    const isMain = model.type === 'Main';
    const showStrip = isMain && tabs.length > 1;

    // One white card, as in the real client: [title block | header fields] over the tab strip.
    const title = '<div class="head-title">'
        + (record
            ? `<div class="form-title"><h1 class="rec">${escapeHtml(record.title)}</h1>`
                + `<span class="form-status">${record.status ? `· ${escapeHtml(record.status)}` : '- Saved'}</span></div>`
            : '<div class="form-title"><h1>(record name)</h1><span class="form-status">- Saved</span></div>')
        + `<div class="form-entity">${escapeHtml(entityName)}</div>`
        + `<div class="form-meta">${escapeHtml(model.name)} · ${escapeHtml(model.type)}</div></div>`;
    const fields = isMain ? renderHeaderFields(model.headerControls, ctx) : '';
    const strip = showStrip
        ? '<div class="tab-strip" role="tablist">'
            + tabs.map((t, i) => `<button type="button" class="tab-btn${i === 0 ? ' active' : ''}" role="tab" data-tab="${i}">${escapeHtml(tabTitle(t))}</button>`).join('')
            + '</div>'
        : '';
    const head = `<div class="form-head">${'<div class="head-row">' + title + fields + '</div>'}${strip}</div>`;

    const panels = tabs.map((t, i) => renderTabPanel(t, i, ctx)).join('');
    return `<div class="d365-form type-${escapeHtml(model.type.toLowerCase().replace(/\s+/g, '-'))}${showStrip ? '' : ' no-strip'}">`
        + notices + head + panels
        + renderFooterStrip(model.footerControls, ctx)
        + '</div>';
}

export function renderErrorHtml(errors: string[]): string {
    return '<div class="d365-form">' + errors.map(e => `<div class="notice error">${escapeHtml(e)}</div>`).join('') + '</div>';
}
