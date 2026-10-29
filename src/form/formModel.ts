import { parse } from 'yaml';

/**
 * Pure model + parser for d365architect `*.form.yml` / `*.table.yml` files.
 * No `vscode` import so it can be shared and unit-tested directly.
 */

export type FormType = 'Main' | 'Card' | 'Quick Create' | 'Quick View Form' | string;

export interface FormControl {
    id?: string;
    /** datafieldname — absent for unbound controls (subgrids, notes, ...). */
    field?: string;
    label?: string;
    /** d365architect friendly control type, e.g. `Lookup`, `Subgrid`. */
    control?: string;
    customControlId?: string;
    /** Name of the web client control a custom control resolves to (from `additionalControls`), e.g. `Microsoft.PowerApps.PowerAppsOneGrid`. */
    webControlName?: string;
    showLabel: boolean;
    visible: boolean;
    disabled: boolean;
    isRequired: boolean;
    columnSpan: number;
    rowSpan: number;
    parameters: Record<string, unknown>;
}

export interface FormSection {
    name?: string;
    label?: string;
    showLabel: boolean;
    visible: boolean;
    /** Number of sub-columns controls flow across (1-4). */
    columns: number;
    controls: FormControl[];
}

export interface FormTabColumn {
    /** Percentage as written in the YAML, e.g. `75%`. */
    width: string;
    sections: FormSection[];
}

export interface FormTab {
    name?: string;
    label?: string;
    visible: boolean;
    columns: FormTabColumn[];
}

export interface FormModel {
    name: string;
    entity: string;
    type: FormType;
    tabs: FormTab[];
    headerControls: FormControl[];
    footerControls: FormControl[];
    /** `formId` from the export (lower-case, no braces), when present — how a quick view control names its form. */
    formId?: string;
}

export interface TableAttribute {
    name: string;
    type?: string;
    displayName?: string;
    requiredLevel?: string;
    format?: string;
    /** Inline option labels (`options: [{value, label}]` in the table YAML), keyed by numeric value. Absent when the file has none. */
    options?: Map<number, string>;
    /** Global choice (option set) the attribute uses; its labels live in the export's `choices.yml`, not inline. */
    globalOptionSetName?: string;
}

export interface TableModel {
    entity: string;
    displayName?: string;
    attributes: Map<string, TableAttribute>;
}

export interface ParseResult<T> {
    model?: T;
    errors: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const span = (v: unknown): number => (typeof v === 'number' && v >= 1 ? Math.floor(v) : 1);

/** The web (formFactor 0) named control among a custom control's `additionalControls`, else the first named one. */
function webControlName(additional: unknown): string | undefined {
    const named = arr(additional).filter(isObj).filter(a => typeof a.name === 'string' && a.name !== '');
    const web = named.find(a => a.formFactor === 0) ?? named[0];
    return web ? (web.name as string) : undefined;
}

function parseControl(raw: unknown): FormControl | undefined {
    if (!isObj(raw)) { return undefined; }
    return {
        id: str(raw.id),
        field: str(raw.field),
        label: str(raw.label),
        control: str(raw.control),
        customControlId: str(raw.customControlId),
        webControlName: webControlName(raw.additionalControls),
        showLabel: bool(raw.showLabel, true),
        visible: bool(raw.visible, true),
        disabled: bool(raw.disabled, false),
        isRequired: bool(raw.isRequired, false),
        columnSpan: span(raw.columnSpan),
        rowSpan: span(raw.rowSpan),
        parameters: isObj(raw.parameters) ? raw.parameters : {},
    };
}

function parseControls(raw: unknown): FormControl[] {
    return arr(raw).map(parseControl).filter((c): c is FormControl => !!c);
}

function parseSection(raw: unknown): FormSection | undefined {
    if (!isObj(raw)) { return undefined; }
    const columns = typeof raw.columns === 'number' ? Math.min(4, Math.max(1, Math.floor(raw.columns))) : 1;
    return {
        name: str(raw.name),
        label: str(raw.label),
        showLabel: bool(raw.showLabel, true),
        visible: bool(raw.visible, true),
        columns,
        controls: parseControls(raw.controls),
    };
}

function parseTab(raw: unknown): FormTab | undefined {
    if (!isObj(raw)) { return undefined; }
    const columns: FormTabColumn[] = arr(raw.columns)
        .filter(isObj)
        .map(c => ({
            width: str(c.width) ?? '100%',
            sections: arr(c.sections).map(parseSection).filter((s): s is FormSection => !!s),
        }));
    return {
        name: str(raw.name),
        label: str(raw.label),
        visible: bool(raw.visible, true),
        columns,
    };
}

export function parseFormYaml(text: string): ParseResult<FormModel> {
    let doc: unknown;
    try {
        doc = parse(text);
    } catch (err) {
        return { errors: [`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!isObj(doc)) {
        return { errors: ['Not a form file: expected a YAML mapping at the top level.'] };
    }
    const errors: string[] = [];
    const entity = str(doc.entity);
    if (!entity) { errors.push('Missing `entity`.'); }
    if (!Array.isArray(doc.tabs)) { errors.push('Missing `tabs` list.'); }
    const model: FormModel = {
        name: str(doc.form) ?? '(unnamed form)',
        entity: entity ?? '',
        type: str(doc.type) ?? 'Main',
        tabs: arr(doc.tabs).map(parseTab).filter((t): t is FormTab => !!t),
        headerControls: parseControls(doc.headerControls),
        footerControls: parseControls(doc.footerControls),
    };
    const formId = normaliseGuid(doc.formId);
    if (formId) { model.formId = formId; }
    return { model, errors };
}

/** `options: [{value, label}]` → value-to-label map; entries without a numeric value are skipped. */
function parseOptions(raw: unknown): Map<number, string> | undefined {
    if (!Array.isArray(raw)) { return undefined; }
    const options = new Map<number, string>();
    for (const o of raw) {
        if (isObj(o) && typeof o.value === 'number' && Number.isFinite(o.value)) {
            options.set(o.value, str(o.label) ?? String(o.value));
        }
    }
    return options;
}

export function parseTableYaml(text: string): ParseResult<TableModel> {
    let doc: unknown;
    try {
        doc = parse(text);
    } catch (err) {
        return { errors: [`Invalid table YAML: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!isObj(doc) || !Array.isArray(doc.attributes)) {
        return { errors: ['Not a table file: missing `attributes` list.'] };
    }
    const attributes = new Map<string, TableAttribute>();
    for (const a of doc.attributes) {
        if (!isObj(a)) { continue; }
        const name = str(a.name);
        if (!name) { continue; }
        attributes.set(name, {
            name,
            type: str(a.type),
            displayName: str(a.displayName),
            requiredLevel: str(a.requiredLevel),
            format: str(a.format),
            options: parseOptions(a.options),
            globalOptionSetName: str(a.globalOptionSetName),
        });
    }
    return {
        model: { entity: str(doc.entity) ?? '', displayName: str(doc.displayName), attributes },
        errors: [],
    };
}

// ── Global choices (`<exportRoot>/choices.yml`) ─────────────────────────────

/** Parses d365architect's `choices.yml` (a list of `{name, displayName, options: [{value, label}]}`) into name → option labels. */
export function parseChoicesYaml(text: string): ParseResult<Map<string, Map<number, string>>> {
    let doc: unknown;
    try {
        doc = parse(text);
    } catch (err) {
        return { errors: [`Invalid choices YAML: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!Array.isArray(doc)) {
        return { errors: ['Not a choices file: expected a list of choices.'] };
    }
    const choices = new Map<string, Map<number, string>>();
    for (const c of doc) {
        if (!isObj(c)) { continue; }
        const name = str(c.name);
        const options = parseOptions(c.options);
        if (name && options) { choices.set(name, options); }
    }
    return { model: choices, errors: [] };
}

/**
 * Fills in option labels for attributes that point at a global choice (`globalOptionSetName`) and have no inline
 * `options`. Returns a new TableModel (the input may be a shared cached parse); inline options always win.
 */
export function applyGlobalChoices(table: TableModel, choices: Map<string, Map<number, string>> | undefined): TableModel {
    if (!choices || choices.size === 0) { return table; }
    const attributes = new Map<string, TableAttribute>();
    for (const [name, attr] of table.attributes) {
        const global = !attr.options && attr.globalOptionSetName ? choices.get(attr.globalOptionSetName) : undefined;
        attributes.set(name, global ? { ...attr, options: global } : attr);
    }
    return { ...table, attributes };
}

// ── Views (for subgrid rendering) ────────────────────────────────────────────

export interface ViewColumn {
    /** Attribute logical name, or `alias.attribute` for a linked-entity column. */
    name: string;
    width?: number;
}

export interface ViewModel {
    name: string;
    entity: string;
    /** d365architect `queryType`, e.g. `SubGrid`, `LookupView`; absent for main views. */
    queryType?: string;
    isDefault: boolean;
    /** `savedqueryid` embedded in the FetchXML, when present — the only link back to a subgrid's `ViewId`. */
    savedQueryId?: string;
    columns: ViewColumn[];
    /** link-entity alias → entity logical name, for labelling `alias.attribute` columns. */
    linkEntities: Map<string, string>;
    /** The view's FetchXML as written (the view previewer reads its sort and filter, and runs it for live rows). */
    fetchXml?: string;
}

export const normaliseGuid = (g: unknown): string =>
    typeof g === 'string' ? g.replace(/[{}]/g, '').trim().toLowerCase() : '';

function xmlAttr(tag: string, name: string): string | undefined {
    const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : undefined;
}

export interface ViewSource {
    name?: string;
    entity: string;
    queryType?: string;
    isDefault?: boolean;
    fetchXml: string;
    layoutXml?: string;
    /** Overrides the id embedded in the FetchXML (a Dataverse `savedqueries` row has no savedqueryid inside its fetchxml). */
    savedQueryId?: string;
}

/** Builds a ViewModel from raw view parts — shared by the YAML export reader and the Dataverse fetch. */
export function buildViewModel(src: ViewSource): ViewModel {
    const fetchXml = src.fetchXml;
    const linkEntities = new Map<string, string>();
    for (const m of fetchXml.matchAll(/<link-entity\b([^>]*)>/g)) {
        const alias = xmlAttr(m[1], 'alias');
        const name = xmlAttr(m[1], 'name');
        if (alias && name) { linkEntities.set(alias, name); }
    }

    let columns: ViewColumn[] = [];
    for (const m of (src.layoutXml ?? '').matchAll(/<cell\b([^>]*)>/g)) {
        const name = xmlAttr(m[1], 'name');
        if (!name) { continue; }
        const w = Number(xmlAttr(m[1], 'width'));
        columns.push({ name, width: Number.isFinite(w) && w > 0 ? w : undefined });
    }
    if (columns.length === 0) {
        // No layoutXml (e.g. lookup/offline views): fall back to the FetchXML attributes, minus the primary id.
        columns = [...fetchXml.matchAll(/<attribute\b([^>]*)>/g)]
            .map(m => xmlAttr(m[1], 'name'))
            .filter((n): n is string => !!n && n !== `${src.entity}id`)
            .map(name => ({ name }));
    }

    const embedded = /savedqueryid="([^"]+)"/i.exec(fetchXml)?.[1];
    const id = normaliseGuid(src.savedQueryId ?? embedded);
    return {
        name: src.name ?? '(unnamed view)',
        entity: src.entity,
        queryType: src.queryType,
        isDefault: src.isDefault === true,
        savedQueryId: id || undefined,
        columns,
        linkEntities,
        fetchXml,
    };
}

export function parseViewYaml(text: string): ParseResult<ViewModel> {
    let doc: unknown;
    try {
        doc = parse(text);
    } catch (err) {
        return { errors: [`Invalid view YAML: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!isObj(doc) || typeof doc.fetchXml !== 'string') {
        return { errors: ['Not a view file: missing `fetchXml`.'] };
    }
    return {
        model: buildViewModel({
            name: str(doc.view),
            entity: str(doc.entity) ?? '',
            queryType: str(doc.queryType),
            isDefault: doc.isDefault === true,
            fetchXml: doc.fetchXml,
            layoutXml: typeof doc.layoutXml === 'string' ? doc.layoutXml : undefined,
        }),
        errors: [],
    };
}

/**
 * Finds the view a subgrid points at, by the `savedqueryid` embedded in an exported view's FetchXML.
 * Exact only: a stand-in view would show plausible but wrong columns, so a miss means "not available here".
 */
export function findViewById(views: ViewModel[], viewId?: string): ViewModel | undefined {
    const id = normaliseGuid(viewId);
    return id ? views.find(v => v.savedQueryId === id) : undefined;
}
