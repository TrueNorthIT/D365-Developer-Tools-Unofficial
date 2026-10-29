import { buildViewModel, FormControl, FormModel, TableModel, ViewModel } from './form/formModel';
import type { QuickViewContent, RecordView, RelatedRows } from './form/formRenderer';
import {
    buildLookupSearchFetch, buildRecordFetch, buildRelatedFetch, formFieldNames, LookupResult, lookupResultColumns,
    mapLookupResult, PrimaryAttributes, quickViewForms, quickViewRecordRef, recordStatus, recordTitle, RelationshipInfo,
} from './form/recordPreview';
import { dataverseErrorMessage } from './view/viewQuery';
import type { RelationshipDefinition } from './dataverseClient';

/**
 * What the live record selector needs from Dataverse. A narrow interface (adapted from DataverseClient in the panel) so
 * this module has no `vscode` dependency and can be unit-tested with a fake. Every call is a read.
 */
export interface RecordRemote {
    /** The connected environment's URL, or undefined when signed out. */
    environment(): string | undefined;
    getPrimaryAttributes(entity: string): Promise<PrimaryAttributes>;
    getAttributes(entity: string): Promise<Array<{ logicalName: string; attributeType: string }>>;
    getRelationship(schemaName: string): Promise<RelationshipDefinition | undefined>;
    getViewByQueryType(entity: string, queryType: number): Promise<{ name: string; fetchXml: string; layoutXml?: string } | undefined>;
    executeFetchXml(entity: string, fetchXml: string, maxRows: number): Promise<Array<Record<string, unknown>>>;
}

/** What the d365architect export (and the subgrid source's table cache) can answer. */
export interface RecordLocal {
    loadViews(entity: string): ViewModel[];
    loadForms(entity: string): FormModel[];
    /** Table labels/types for an entity (export first, Dynamics in the background); undefined until known. */
    loadTable(entity: string): TableModel | undefined;
}

export interface SelectedRecord {
    entity: string;
    id: string;
    /** Name shown in the lookup chip. */
    name: string;
    environment: string;
}

/** What the panel renders for the current selection. */
export interface RecordViewResult {
    /** Undefined when nothing is selected, or the record hasn't loaded (or failed). */
    record?: RecordView;
    /** Loading / error notices to show above the form (the form still renders). */
    notices: string[];
}

const QUERY_TYPE_QUICK_FIND = 4;
const QUERY_TYPE_LOOKUP = 64;
const SEARCH_TOP = 10;
const RELATED_ROWS = 50;
const RECENT_CAP = 10;
const LOGICAL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA_NAME_RE = /^[A-Za-z0-9_]+$/;

type State<T> = { kind: 'loading' } | { kind: 'done'; value: T } | { kind: 'error'; message: string };
interface Tracked<T> { promise: Promise<T>; state: State<T> }

const errorText = (err: unknown): string => dataverseErrorMessage(err instanceof Error ? err.message : String(err));

/** Records picked in this VS Code session, per environment + table, most recent first (shared by every panel). */
const recentRecords = new Map<string, LookupResult[]>();

export function rememberRecent(environment: string, entity: string, item: LookupResult): void {
    const key = `${environment}|${entity}`;
    const list = (recentRecords.get(key) ?? []).filter(r => r.id !== item.id);
    recentRecords.set(key, [item, ...list].slice(0, RECENT_CAP));
}

export function recentRecordsFor(environment: string, entity: string): LookupResult[] {
    return [...(recentRecords.get(`${environment}|${entity}`) ?? [])];
}

/** Test hook: forget every recent record. */
export function clearRecentRecords(): void {
    recentRecords.clear();
}

function tableFromAttributes(entity: string, attrs: Array<{ logicalName: string; attributeType: string }>): TableModel {
    return { entity, attributes: new Map(attrs.map(a => [a.logicalName, { name: a.logicalName, type: a.attributeType }])) };
}

/** Form fields to read: those the table has, minus party lists (which FetchXML can't select). */
function readableFields(model: FormModel, table: TableModel | undefined): string[] {
    return formFieldNames(model, table).filter(f => table?.attributes.get(f)?.type !== 'PartyList');
}

/**
 * Holds the record picked in one form preview and loads, in the background, everything the form shows for it: the record
 * itself (one query for every field on the form), each subgrid's related rows, and each quick view's related record.
 * The renderer is synchronous, so reads return whatever has arrived and `onChange` fires when more lands. Read-only:
 * nothing is ever written to Dataverse.
 *
 * Metadata (primary attributes, live attribute lists, relationships, Quick Find / Lookup views) is cached until `reset()`;
 * record data is dropped whenever the selection changes. A late response for an earlier selection is ignored.
 */
export class FormRecordSource {
    private selection: SelectedRecord | undefined;
    /** Bumped on select / clear / reset: responses started under an older generation are dropped. */
    private generation = 0;
    private disposed = false;

    private readonly primaries = new Map<string, Tracked<PrimaryAttributes>>();
    private readonly liveAttributes = new Map<string, Tracked<TableModel>>();
    private readonly relationships = new Map<string, Tracked<RelationshipDefinition | undefined>>();
    private readonly systemViews = new Map<string, Tracked<ViewModel | undefined>>();
    /** Tables whose Quick Find query Dynamics rejected; their searches use the primary name only. */
    private readonly brokenQuickFind = new Set<string>();

    private main: { fields: Set<string>; state: State<Record<string, unknown> | undefined> } | undefined;
    /** Last record successfully loaded for the selection (kept on screen while a re-fetch for new fields runs). */
    private shown: Record<string, unknown> | undefined;
    /** Field sets already fetched or tried, so an added field triggers one re-fetch, not a loop. */
    private readonly triedFields = new Set<string>();
    private refetchTimer: NodeJS.Timeout | undefined;
    private readonly related = new Map<string, Tracked<Array<Record<string, unknown>>>>();
    private readonly quickRecords = new Map<string, Tracked<Record<string, unknown> | undefined>>();

    constructor(
        private readonly local: RecordLocal,
        private readonly remote: RecordRemote,
        private readonly onChange: () => void,
        private readonly refetchDelayMs = 800,
    ) {}

    get selected(): SelectedRecord | undefined {
        return this.selection;
    }

    /** Selects a record picked from the lookup and remembers it as recent. */
    select(entity: string, item: LookupResult): void {
        const environment = this.remote.environment();
        if (!environment || !LOGICAL_NAME_RE.test(entity)) { return; }
        this.clear();
        this.selection = { entity, id: item.id, name: item.primary, environment };
        rememberRecent(environment, entity, item);
    }

    /** Forgets the selected record and everything loaded for it. */
    clear(): void {
        this.generation++;
        this.selection = undefined;
        this.main = undefined;
        this.shown = undefined;
        this.triedFields.clear();
        clearTimeout(this.refetchTimer);
        this.related.clear();
        this.quickRecords.clear();
    }

    /** Sign-in, sign-out or environment switch: forget the record and all cached metadata. */
    reset(): void {
        this.clear();
        this.primaries.clear();
        this.liveAttributes.clear();
        this.relationships.clear();
        this.systemViews.clear();
        this.brokenQuickFind.clear();
    }

    dispose(): void {
        this.disposed = true;
        this.clear();
    }

    recents(entity: string): LookupResult[] {
        const environment = this.remote.environment();
        return environment ? recentRecordsFor(environment, entity) : [];
    }

    // ── Search (REQ-3, REQ-4) ───────────────────────────────────────────────

    /**
     * Up to 10 records matching `text` through the table's Quick Find view, with the Lookup View's columns. If Dynamics
     * rejects the Quick Find query (e.g. a `like` on a lookup column), retries once on the primary name only and keeps
     * doing so for that table.
     */
    async search(entity: string, text: string): Promise<LookupResult[]> {
        if (!this.remote.environment()) { throw new Error('Not signed in to Dynamics.'); }
        if (!LOGICAL_NAME_RE.test(entity)) { throw new Error(`"${entity}" is not a table logical name.`); }
        const primary = await this.primary(entity).promise;
        const [quickFind, lookupView] = await Promise.all([
            this.brokenQuickFind.has(entity) ? Promise.resolve(undefined) : this.systemView(entity, 'QuickFindSearch', QUERY_TYPE_QUICK_FIND),
            this.systemView(entity, 'LookupView', QUERY_TYPE_LOOKUP),
        ]);
        const columns = lookupResultColumns(lookupView?.columns, primary.name);

        const attempts: Array<{ quickFind?: string; columns: string[] }> = [];
        if (quickFind?.fetchXml) { attempts.push({ quickFind: quickFind.fetchXml, columns }); }
        attempts.push({ columns });
        if (columns.length > 1) { attempts.push({ columns: [primary.name] }); }

        let lastError: unknown;
        for (const [i, attempt] of attempts.entries()) {
            const fetchXml = buildLookupSearchFetch(entity, attempt.quickFind, attempt.columns, text, primary, SEARCH_TOP);
            try {
                const records = await this.remote.executeFetchXml(entity, fetchXml, SEARCH_TOP);
                return records.map(r => mapLookupResult(r, attempt.columns, primary.id)).filter(r => r.id);
            } catch (err) {
                lastError = err;
                if (i === 0 && attempt.quickFind) { this.brokenQuickFind.add(entity); }
            }
        }
        throw lastError;
    }

    /** The export's view of this type for the table (default first), else the one fetched from Dynamics. */
    private async systemView(entity: string, queryType: string, queryTypeCode: number): Promise<ViewModel | undefined> {
        const exported = this.local.loadViews(entity).filter(v => v.queryType === queryType);
        const local = exported.find(v => v.isDefault) ?? exported[0];
        if (local) { return local; }
        return this.track(this.systemViews, `${entity}|${queryTypeCode}`, async () => {
            const q = await this.remote.getViewByQueryType(entity, queryTypeCode);
            return q ? buildViewModel({ name: q.name, entity, queryType, fetchXml: q.fetchXml, layoutXml: q.layoutXml }) : undefined;
        }).promise.catch(() => undefined);
    }

    // ── The selected record (REQ-7, REQ-8, REQ-12) ──────────────────────────

    /** What to render for `model` right now; starts (or re-starts) whatever still needs loading. */
    view(model: FormModel, table: TableModel | undefined): RecordViewResult {
        const sel = this.selection;
        if (!sel) { return { notices: [] }; }
        if (sel.entity !== model.entity || sel.environment !== this.remote.environment()) {
            this.clear();
            return { notices: [] };
        }
        const loading = { notices: [`Loading ${sel.name || 'record'} from ${sel.environment}…`] };

        const primary = this.primary(sel.entity).state;
        if (primary.kind === 'error') { return { notices: [primary.message] }; }
        const live = this.attributes(sel.entity).state;
        if (primary.kind === 'loading' || live.kind === 'loading') { return loading; }

        // Only ask for attributes the live table has (a stale export or a typo would fail the whole query).
        const fields = readableFields(model, live.kind === 'done' ? live.value : table);
        this.ensureMain(sel, primary.value, fields);

        const main = this.main!;
        if (main.state.kind === 'error' && !this.shown) { return { notices: [main.state.message] }; }
        if (main.state.kind === 'done' && main.state.value === undefined) {
            return { notices: [`${sel.name || 'The record'} wasn't found in ${sel.environment}: it may have been deleted, or you may not have access to it.`] };
        }
        const record = this.shown;
        if (!record) { return loading; }
        return {
            notices: main.state.kind === 'error' ? [main.state.message] : [],
            record: {
                record,
                title: recordTitle(record, primary.value.name),
                status: recordStatus(record),
                subgridRows: (control, view) => this.subgridRows(sel, control, view),
                quickView: control => this.quickView(record, control),
            },
        };
    }

    /** Fetches the record for `fields`, once; when the form gains fields the record lacks, re-fetches once after a pause. */
    private ensureMain(sel: SelectedRecord, primary: PrimaryAttributes, fields: string[]): void {
        const key = [...fields].sort().join(',');
        if (!this.main) {
            this.fetchMain(sel, primary, fields, key);
            return;
        }
        const missing = fields.some(f => !this.main!.fields.has(f));
        if (!missing || this.triedFields.has(key)) { return; }
        clearTimeout(this.refetchTimer);
        const gen = this.generation;
        this.refetchTimer = setTimeout(() => {
            if (gen === this.generation && !this.disposed) { this.fetchMain(sel, primary, fields, key); }
        }, this.refetchDelayMs);
    }

    private fetchMain(sel: SelectedRecord, primary: PrimaryAttributes, fields: string[], key: string): void {
        this.triedFields.add(key);
        const gen = this.generation;
        const entry: { fields: Set<string>; state: State<Record<string, unknown> | undefined> } = {
            fields: new Set(fields),
            state: { kind: 'loading' },
        };
        this.main = entry;
        Promise.resolve()
            .then(() => this.remote.executeFetchXml(sel.entity, buildRecordFetch(sel.entity, fields, primary.id, sel.id), 1))
            .then(
                records => {
                    if (gen !== this.generation || this.main !== entry) { return; }
                    entry.state = { kind: 'done', value: records[0] };
                    if (records[0]) { this.shown = records[0]; }
                },
                err => {
                    if (gen !== this.generation || this.main !== entry) { return; }
                    entry.state = { kind: 'error', message: errorText(err) };
                },
            )
            .finally(() => { if (gen === this.generation) { this.changed(); } });
    }

    // ── Subgrids (REQ-9) ────────────────────────────────────────────────────

    private subgridRows(sel: SelectedRecord, control: FormControl, view: ViewModel): RelatedRows {
        const relationship = control.parameters['RelationshipName'];
        const target = control.parameters['TargetEntityType'];
        if (typeof relationship !== 'string' || typeof target !== 'string' || !view.fetchXml) {
            return { kind: 'error', message: 'This subgrid has no relationship or view to load rows with.' };
        }
        const key = `${relationship}\n${target}\n${view.fetchXml}`;
        const tracked = this.trackRecordData(this.related, key, async () => {
            if (!SCHEMA_NAME_RE.test(relationship) || !LOGICAL_NAME_RE.test(target)) {
                throw new Error(`Relationship ${relationship} or table ${target} isn't a valid name.`);
            }
            const def = await this.relationship(relationship).promise;
            if (!def) { throw new Error(`Relationship ${relationship} wasn't found in ${sel.environment}.`); }
            const info = await this.relationshipInfo(def, sel.entity, target);
            const fetchXml = buildRelatedFetch(view.fetchXml!, info, sel.id);
            if (fetchXml === view.fetchXml) { throw new Error(`The view ${view.name} has FetchXML that can't be read, so its rows can't be filtered to this record.`); }
            return this.remote.executeFetchXml(target, fetchXml, RELATED_ROWS);
        });
        const s = tracked.state;
        return s.kind === 'done' ? { kind: 'rows', records: s.value } : s;
    }

    /** Which side of the relationship this record is on, as the filter `buildRelatedFetch` needs. */
    private async relationshipInfo(def: RelationshipDefinition, entity: string, target: string): Promise<RelationshipInfo> {
        if (def.kind === 'OneToMany') {
            if (def.referencedEntity !== entity || def.referencingEntity !== target) {
                throw new Error(`Relationship ${def.schemaName} links ${def.referencedEntity} to ${def.referencingEntity}, not ${entity} to ${target}.`);
            }
            return { kind: 'OneToMany', referencingAttribute: def.referencingAttribute };
        }
        // Many-to-many: this record's side is the entity that matches; a self-referencing relationship uses side 1.
        const thisIs1 = def.entity1 === entity && def.entity2 === target;
        const thisIs2 = def.entity2 === entity && def.entity1 === target;
        if (!thisIs1 && !thisIs2) {
            throw new Error(`Relationship ${def.schemaName} links ${def.entity1} and ${def.entity2}, not ${entity} and ${target}.`);
        }
        const otherPrimary = await this.primary(target).promise;
        return {
            kind: 'ManyToMany',
            intersectEntity: def.intersectEntity,
            thisEntityIntersectAttribute: thisIs1 ? def.entity1IntersectAttribute : def.entity2IntersectAttribute,
            otherEntityIntersectAttribute: thisIs1 ? def.entity2IntersectAttribute : def.entity1IntersectAttribute,
            otherEntityPrimaryId: otherPrimary.id,
        };
    }

    // ── Quick views (REQ-10) ────────────────────────────────────────────────

    private quickView(record: Record<string, unknown>, control: FormControl): QuickViewContent {
        const forms = quickViewForms(control);
        if (forms.length === 0) { return { note: 'This quick view names no quick view form, so it can\'t show the related record.' }; }
        const ref = quickViewRecordRef(control, record);
        const lookupValue = control.field ? record[`_${control.field}_value`] : undefined;
        if (!ref && lookupValue !== undefined && lookupValue !== null && lookupValue !== '') {
            return { note: 'The related record is in a table this quick view form doesn\'t cover.' };
        }
        const target = ref ? { entity: ref.entity, formId: ref.formId } : forms[0];
        const model = target.formId ? this.local.loadForms(target.entity).find(f => f.formId === target.formId) : undefined;
        if (!model) {
            return { note: `Quick view form ${target.formId ?? '(no id)'} isn't in the export under ${target.entity}/, so it can't be shown.` };
        }
        const form = { model, table: this.local.loadTable(target.entity) };
        if (!ref) { return { form }; } // empty lookup: a blank quick view

        const names = formFieldNames(model);
        const key = `${ref.entity}\n${ref.id}\n${names.sort().join(',')}`;
        const tracked = this.trackRecordData(this.quickRecords, key, async () => {
            if (!LOGICAL_NAME_RE.test(ref.entity)) { throw new Error(`"${ref.entity}" is not a table logical name.`); }
            const [primary, live] = await Promise.all([
                this.primary(ref.entity).promise,
                this.attributes(ref.entity).promise.catch(() => undefined),
            ]);
            const fields = readableFields(model, live ?? form.table);
            const records = await this.remote.executeFetchXml(ref.entity, buildRecordFetch(ref.entity, fields, primary.id, ref.id), 1);
            return records[0];
        });
        const s = tracked.state;
        if (s.kind === 'loading') { return { form, loading: true }; }
        if (s.kind === 'error') { return { form, error: s.message }; }
        return s.value ? { form, record: s.value } : { form, note: 'The related record wasn\'t found, or you don\'t have access to it.' };
    }

    // ── Cached loads ────────────────────────────────────────────────────────

    private primary(entity: string): Tracked<PrimaryAttributes> {
        return this.track(this.primaries, entity, () => this.remote.getPrimaryAttributes(entity));
    }

    private attributes(entity: string): Tracked<TableModel> {
        return this.track(this.liveAttributes, entity, async () => tableFromAttributes(entity, await this.remote.getAttributes(entity)));
    }

    private relationship(schemaName: string): Tracked<RelationshipDefinition | undefined> {
        return this.track(this.relationships, schemaName, () => this.remote.getRelationship(schemaName));
    }

    /** Metadata: loaded once (failures included) until `reset()`; a load that lands re-renders the form. */
    private track<T>(map: Map<string, Tracked<T>>, key: string, load: () => Promise<T>): Tracked<T> {
        const existing = map.get(key);
        if (existing) { return existing; }
        const tracked: Tracked<T> = { state: { kind: 'loading' }, promise: Promise.resolve().then(load) };
        map.set(key, tracked);
        tracked.promise.then(
            value => { tracked.state = { kind: 'done', value }; },
            err => { tracked.state = { kind: 'error', message: errorText(err) }; },
        ).finally(() => { if (map.get(key) === tracked) { this.changed(); } });
        // The promise is also awaited by callers; keep an unobserved rejection from being reported as unhandled.
        tracked.promise.catch(() => undefined);
        return tracked;
    }

    /** Record data: like `track`, but dropped (and late responses ignored) when the selection changes. */
    private trackRecordData<T>(map: Map<string, Tracked<T>>, key: string, load: () => Promise<T>): Tracked<T> {
        const gen = this.generation;
        const existing = map.get(key);
        if (existing) { return existing; }
        const tracked: Tracked<T> = { state: { kind: 'loading' }, promise: Promise.resolve().then(load) };
        map.set(key, tracked);
        tracked.promise.then(
            value => { tracked.state = { kind: 'done', value }; },
            err => { tracked.state = { kind: 'error', message: errorText(err) }; },
        ).finally(() => { if (gen === this.generation) { this.changed(); } });
        tracked.promise.catch(() => undefined);
        return tracked;
    }

    private changed(): void {
        if (!this.disposed) { this.onChange(); }
    }
}
