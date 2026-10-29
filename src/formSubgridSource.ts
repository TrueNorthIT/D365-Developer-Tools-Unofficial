import { buildViewModel, findViewById, normaliseGuid, TableModel, ViewModel } from './form/formModel';
import type { SubgridSource, ViewOrigin } from './form/formRenderer';

/**
 * What the preview needs from Dataverse. A narrow interface (adapted from DataverseClient in the panel) so this
 * module has no `vscode` dependency and can be unit-tested with a fake.
 */
export interface RemoteMetadata {
    isConnected(): boolean;
    getSavedQuery(savedQueryId: string): Promise<{
        name: string;
        entity: string;
        queryType: number;
        isDefault: boolean;
        fetchXml: string;
        layoutXml?: string;
    } | undefined>;
    getAttributes(entity: string): Promise<Array<{ logicalName: string; displayName: string; attributeType: string }>>;
    getEntityDisplayName(entity: string): Promise<string>;
}

/** The part of SiblingTableLoader this needs: what the d365architect export on disk can answer. */
export interface LocalExport {
    loadViews(entity: string): ViewModel[];
    loadTable(entity: string): TableModel | undefined;
}

/** Dataverse `querytype` value for an associated (subgrid) view. */
const QUERY_TYPE_ASSOCIATED = 2;

/**
 * Resolves subgrid views in three tiers: the export on disk, then Dynamics (when signed in), then nothing.
 *
 * The renderer is synchronous, so Dynamics lookups are kicked off in the background the first time something
 * unresolved is asked for; `onChange` fires when one lands so the panel can re-render. A failed lookup (offline,
 * no permission, view not found) is remembered until `reset()` so it isn't retried on every keystroke.
 */
export class FormSubgridSource implements SubgridSource {
    private readonly views = new Map<string, ViewModel>();
    private readonly tables = new Map<string, TableModel>();
    private readonly inflight = new Set<string>();
    private readonly failed = new Set<string>();
    private disposed = false;

    constructor(
        private readonly local: LocalExport,
        private readonly remote: RemoteMetadata | undefined,
        private readonly onChange: () => void,
    ) {}

    resolveView(entity: string, viewId: string | undefined): { view?: ViewModel; origin?: ViewOrigin } {
        const id = normaliseGuid(viewId);
        if (!id) { return {}; }

        const exported = findViewById(this.local.loadViews(entity), id);
        if (exported) { return { view: exported, origin: 'export' }; }

        const fetched = this.views.get(id);
        if (fetched) { return { view: fetched, origin: 'dynamics' }; }

        this.fetchOnce(`view:${id}`, async () => {
            const q = await this.remote!.getSavedQuery(id);
            if (!q) { return false; }
            this.views.set(id, buildViewModel({
                name: q.name,
                entity: q.entity,
                queryType: q.queryType === QUERY_TYPE_ASSOCIATED ? 'SubGrid' : undefined,
                isDefault: q.isDefault,
                fetchXml: q.fetchXml,
                layoutXml: q.layoutXml,
                savedQueryId: id,
            }));
            return true;
        });
        return {};
    }

    loadTable(entity: string): TableModel | undefined {
        const exported = this.local.loadTable(entity);
        if (exported) { return exported; }

        const fetched = this.tables.get(entity);
        if (fetched) { return fetched; }

        this.fetchOnce(`table:${entity}`, async () => {
            const [attrs, displayName] = await Promise.all([
                this.remote!.getAttributes(entity),
                this.remote!.getEntityDisplayName(entity).catch(() => undefined),
            ]);
            this.tables.set(entity, {
                entity,
                displayName,
                attributes: new Map(attrs.map(a => [a.logicalName, {
                    name: a.logicalName, type: a.attributeType, displayName: a.displayName,
                }])),
            });
            return true;
        });
        return undefined;
    }

    /** Forget failed lookups (e.g. after the connection changes) so they're attempted again. */
    reset(): void {
        this.failed.clear();
    }

    dispose(): void {
        this.disposed = true;
    }

    /** Runs `load` in the background unless it's already running, already failed, or we're offline. */
    private fetchOnce(key: string, load: () => Promise<boolean>): void {
        if (!this.remote || !this.remote.isConnected() || this.inflight.has(key) || this.failed.has(key)) { return; }
        this.inflight.add(key);
        load()
            .then(found => {
                if (!found) { this.failed.add(key); return; }
                if (!this.disposed) { this.onChange(); }
            })
            .catch(() => { this.failed.add(key); })
            .finally(() => { this.inflight.delete(key); });
    }
}
