import type { ConnectionManager } from './connectionManager';

// ── Dataverse OData response shapes ────────────────────────────────────────

interface ODataResponse<T> {
    value: T[];
    '@odata.nextLink'?: string;
}

interface DataverseLabel {
    LocalizedLabels: Array<{ Label: string; LanguageCode: number }>;
    UserLocalizedLabel?: { Label: string; LanguageCode: number };
}

interface EntityDefinitionResponse {
    MetadataId: string;
    LogicalName: string;
    SchemaName: string;
    DisplayName: DataverseLabel;
    IsCustomEntity: boolean;
    IconVectorName: string | null;
    ObjectTypeCode: number | null;
}

interface SavedQueryResponse {
    savedqueryid: string;
    name: string;
    returnedtypecode: string;
    querytype: number;
    isdefault?: boolean;
    fetchxml: string;
    layoutxml?: string | null;
}

interface RelationshipResponse {
    '@odata.type'?: string;
    SchemaName: string;
    /** 0 = one-to-many, 1 = many-to-many. */
    RelationshipType?: number | string;
    ReferencedEntity?: string;
    ReferencingEntity?: string;
    ReferencingAttribute?: string;
    IntersectEntityName?: string;
    Entity1LogicalName?: string;
    Entity1IntersectAttribute?: string;
    Entity2LogicalName?: string;
    Entity2IntersectAttribute?: string;
}

interface AttributeDefinitionResponse {
    LogicalName: string;
    SchemaName: string;
    DisplayName: DataverseLabel;
    AttributeType: string;
    IsPrimaryId: boolean;
    IsPrimaryName: boolean;
}

interface SolutionResponse {
    solutionid: string;
    uniquename: string;
    friendlyname: string;
}

interface SolutionComponentResponse {
    objectid: string;
}

interface OptionSetItems {
    Options: Array<{ Value: number; Label: DataverseLabel }>;
}

interface AttributeOptionsResponse {
    OptionSet?: OptionSetItems;
    GlobalOptionSet?: OptionSetItems;
}

const OPTION_SET_CAST: Record<string, string> = {
    Picklist: 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
    State:    'Microsoft.Dynamics.CRM.StateAttributeMetadata',
    Status:   'Microsoft.Dynamics.CRM.StatusAttributeMetadata',
};

// ── Public domain types ─────────────────────────────────────────────────────

export interface EntityDefinition {
    metadataId: string;
    logicalName: string;
    schemaName: string;
    displayName: string;
    isCustom: boolean;
    /** Logical name of the SVG web resource used as this table's Unified Interface icon, if any. */
    iconVectorName?: string;
    /** Numeric entity type code — used to resolve the built-in /_imgs/svg_<otc>.svg icon for system tables. */
    objectTypeCode?: number;
}

export interface AttributeDefinition {
    logicalName: string;
    schemaName: string;
    displayName: string;
    attributeType: string;
    isPrimaryId: boolean;
    isPrimaryName: boolean;
}

export interface Solution {
    solutionId: string;
    uniqueName: string;
    friendlyName: string;
}

export interface OptionValue {
    value: number;
    label: string;
}

/** A system view (`savedquery` row), as needed to render a subgrid's columns. */
export interface SavedQueryDefinition {
    savedQueryId: string;
    name: string;
    /** Logical name of the table the view is on. */
    entity: string;
    /** Numeric `querytype`: 0 = public view, 2 = associated (subgrid) view, 64 = lookup view, … */
    queryType: number;
    isDefault: boolean;
    fetchXml: string;
    layoutXml?: string;
}

/** Primary id / primary name attribute logical names of a table. */
export interface PrimaryAttributeNames {
    id: string;
    name: string;
}

/** A relationship as needed to filter a subgrid to one record's related rows. */
export type RelationshipDefinition =
    | { kind: 'OneToMany'; schemaName: string; referencedEntity: string; referencingEntity: string; referencingAttribute: string }
    | {
        kind: 'ManyToMany';
        schemaName: string;
        intersectEntity: string;
        entity1: string;
        entity1IntersectAttribute: string;
        entity2: string;
        entity2IntersectAttribute: string;
    };

// ── Client ──────────────────────────────────────────────────────────────────

export class DataverseClient {
    /** `<environmentUrl>|<entity>` → entity set name; metadata that never changes within an environment. */
    private readonly entitySetNames = new Map<string, string>();
    /** `<environmentUrl>|<entity>` → primary id / name attributes. */
    private readonly primaryAttributes = new Map<string, PrimaryAttributeNames>();
    /** `<environmentUrl>|<schema name>` → relationship (undefined = not found). */
    private readonly relationships = new Map<string, RelationshipDefinition | undefined>();

    constructor(private readonly connectionManager: ConnectionManager) {}

    async getEntities(): Promise<EntityDefinition[]> {
        const url = this.apiUrl(
            'EntityDefinitions',
            '$select=MetadataId,LogicalName,SchemaName,DisplayName,IsCustomEntity,IconVectorName,ObjectTypeCode',
        );

        const raw = await this.fetchPaged<EntityDefinitionResponse>(url);
        return raw.map(e => ({
            metadataId: e.MetadataId,
            logicalName: e.LogicalName,
            schemaName: e.SchemaName,
            displayName: extractLabel(e.DisplayName) || e.SchemaName,
            isCustom: e.IsCustomEntity,
            iconVectorName: e.IconVectorName || undefined,
            objectTypeCode: typeof e.ObjectTypeCode === 'number' ? e.ObjectTypeCode : undefined,
        })).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
    }

    async getAttributes(entityLogicalName: string): Promise<AttributeDefinition[]> {
        const url = this.apiUrl(
            `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes`,
            '$select=LogicalName,SchemaName,DisplayName,AttributeType,IsPrimaryId,IsPrimaryName',
        );

        const raw = await this.fetchPaged<AttributeDefinitionResponse>(url);
        return raw
            .map(a => ({
                logicalName: a.LogicalName,
                schemaName: a.SchemaName,
                displayName: extractLabel(a.DisplayName) || a.SchemaName,
                attributeType: a.AttributeType,
                isPrimaryId: a.IsPrimaryId,
                isPrimaryName: a.IsPrimaryName,
            }))
            .sort((a, b) => a.logicalName.localeCompare(b.logicalName));
    }

    /** Fetches one system view by id (a form subgrid's `ViewId`). Resolves `undefined` if no such view exists. */
    async getSavedQuery(savedQueryId: string): Promise<SavedQueryDefinition | undefined> {
        const id = savedQueryId.replace(/[{}]/g, '');
        const url = this.apiUrl(
            `savedqueries(${id})`,
            '$select=savedqueryid,name,returnedtypecode,querytype,isdefault,fetchxml,layoutxml',
        );
        let row: SavedQueryResponse | undefined;
        try {
            row = await this.request<SavedQueryResponse>(url);
        } catch (err) {
            if (err instanceof Error && /Dataverse API error 404/.test(err.message)) { return undefined; }
            throw err;
        }
        if (!row) { return undefined; }
        return {
            savedQueryId: row.savedqueryid,
            name: row.name,
            entity: row.returnedtypecode,
            queryType: row.querytype,
            isDefault: row.isdefault === true,
            fetchXml: row.fetchxml,
            layoutXml: row.layoutxml || undefined,
        };
    }

    /** The table's display name, e.g. `Manager` for `tn_manager`. Falls back to the logical name if it has no label. */
    async getEntityDisplayName(entityLogicalName: string): Promise<string> {
        const url = this.apiUrl(`EntityDefinitions(LogicalName='${entityLogicalName}')`, '$select=LogicalName,DisplayName');
        const row = await this.request<{ LogicalName: string; DisplayName?: DataverseLabel }>(url);
        return extractLabel(row?.DisplayName) || entityLogicalName;
    }

    /** The table's Web API collection name, e.g. `contacts` for `contact`. Cached per environment. */
    async getEntitySetName(entityLogicalName: string): Promise<string> {
        const key = `${this.connectionManager.connection!.environmentUrl}|${entityLogicalName}`;
        const cached = this.entitySetNames.get(key);
        if (cached) { return cached; }
        const url = this.apiUrl(`EntityDefinitions(LogicalName='${entityLogicalName}')`, '$select=EntitySetName');
        const row = await this.request<{ EntitySetName?: string }>(url);
        if (!row?.EntitySetName) { throw new Error(`Table ${entityLogicalName} has no Web API entity set.`); }
        this.entitySetNames.set(key, row.EntitySetName);
        return row.EntitySetName;
    }

    /** The table's primary id and primary name attributes, e.g. `contactid` / `fullname`. Cached per environment. */
    async getPrimaryAttributes(entityLogicalName: string): Promise<PrimaryAttributeNames> {
        const key = `${this.connectionManager.connection!.environmentUrl}|${entityLogicalName}`;
        const cached = this.primaryAttributes.get(key);
        if (cached) { return cached; }
        const url = this.apiUrl(`EntityDefinitions(LogicalName='${entityLogicalName}')`, '$select=PrimaryIdAttribute,PrimaryNameAttribute');
        const row = await this.request<{ PrimaryIdAttribute?: string | null; PrimaryNameAttribute?: string | null }>(url);
        if (!row?.PrimaryIdAttribute) { throw new Error(`Table ${entityLogicalName} has no primary id attribute.`); }
        // A few system tables (intersect tables) have no primary name; fall back to the id so a title still shows.
        const result = { id: row.PrimaryIdAttribute, name: row.PrimaryNameAttribute || row.PrimaryIdAttribute };
        this.primaryAttributes.set(key, result);
        return result;
    }

    /**
     * A relationship by schema name (a subgrid's `RelationshipName`), one-to-many or many-to-many. Resolves `undefined`
     * when no such relationship exists. Cached per environment.
     */
    async getRelationship(schemaName: string): Promise<RelationshipDefinition | undefined> {
        const key = `${this.connectionManager.connection!.environmentUrl}|${schemaName}`;
        if (this.relationships.has(key)) { return this.relationships.get(key); }
        const url = this.apiUrl(`RelationshipDefinitions(SchemaName='${schemaName.replace(/'/g, "''")}')`);
        let row: RelationshipResponse | undefined;
        try {
            row = await this.request<RelationshipResponse>(url);
        } catch (err) {
            if (!(err instanceof Error && /Dataverse API error 404/.test(err.message))) { throw err; }
        }
        let result: RelationshipDefinition | undefined;
        const manyToMany = row && (/ManyToMany/.test(row['@odata.type'] ?? '')
            || /ManyToMany|^1$/.test(String(row.RelationshipType ?? '')) || row.IntersectEntityName !== undefined);
        if (row && manyToMany) {
            result = {
                kind: 'ManyToMany',
                schemaName: row.SchemaName,
                intersectEntity: row.IntersectEntityName ?? '',
                entity1: row.Entity1LogicalName ?? '',
                entity1IntersectAttribute: row.Entity1IntersectAttribute ?? '',
                entity2: row.Entity2LogicalName ?? '',
                entity2IntersectAttribute: row.Entity2IntersectAttribute ?? '',
            };
        } else if (row) {
            result = {
                kind: 'OneToMany',
                schemaName: row.SchemaName,
                referencedEntity: row.ReferencedEntity ?? '',
                referencingEntity: row.ReferencingEntity ?? '',
                referencingAttribute: row.ReferencingAttribute ?? '',
            };
        }
        this.relationships.set(key, result);
        return result;
    }

    /** The table's default system view of one `querytype` (4 = Quick Find, 64 = Lookup), else any view of that type. */
    async getViewByQueryType(entityLogicalName: string, queryType: number): Promise<SavedQueryDefinition | undefined> {
        const url = this.apiUrl(
            'savedqueries',
            '$select=savedqueryid,name,returnedtypecode,querytype,isdefault,fetchxml,layoutxml',
            `$filter=returnedtypecode eq '${entityLogicalName.replace(/'/g, "''")}' and querytype eq ${Math.floor(queryType)}`,
        );
        const data = await this.request<ODataResponse<SavedQueryResponse>>(url);
        const rows = data?.value ?? [];
        const row = rows.find(r => r.isdefault === true) ?? rows[0];
        if (!row) { return undefined; }
        return {
            savedQueryId: row.savedqueryid,
            name: row.name,
            entity: row.returnedtypecode,
            queryType: row.querytype,
            isDefault: row.isdefault === true,
            fetchXml: row.fetchxml,
            layoutXml: row.layoutxml || undefined,
        };
    }

    /**
     * Runs a FetchXML query and returns the first page of records (at most `maxRows`, never more than one request),
     * with all annotations (formatted values, and lookup logical names for polymorphic lookups). Any paging in the FetchXML is replaced so the limit always holds.
     */
    async executeFetchXml(entityLogicalName: string, fetchXml: string, maxRows = 50): Promise<Array<Record<string, unknown>>> {
        const entitySet = await this.getEntitySetName(entityLogicalName);
        const url = this.apiUrl(entitySet, `fetchXml=${encodeURIComponent(limitFetchXml(fetchXml, maxRows))}`);
        const token = await this.connectionManager.getAccessToken();
        const response = await fetch(url, {
            headers: {
                ...this.headers(token),
                Prefer: 'odata.include-annotations="*"',
            },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Dataverse API error ${response.status}: ${body || response.statusText}`);
        }
        const page = await response.json() as ODataResponse<Record<string, unknown>>;
        return (page.value ?? []).slice(0, maxRows);
    }

    async getSolutions(): Promise<Solution[]> {
        // isvisible filters out internal/system solutions like "Default Solution"
        const url = this.apiUrl(
            'solutions',
            '$select=solutionid,uniquename,friendlyname',
            '$filter=isvisible eq true',
            '$orderby=friendlyname',
        );

        const raw = await this.fetchPaged<SolutionResponse>(url);
        return raw.map(s => ({
            solutionId: s.solutionid,
            uniqueName: s.uniquename,
            friendlyName: s.friendlyname,
        }));
    }

    async getAttributeOptions(entityLogicalName: string, attributeLogicalName: string, attributeType: string): Promise<OptionValue[]> {
        const cast = OPTION_SET_CAST[attributeType];
        if (!cast) { throw new Error(`${attributeType} is not an option-set attribute type`); }

        const base = this.connectionManager.connection!.environmentUrl;
        const url  = `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes(LogicalName='${attributeLogicalName}')/${cast}?$expand=OptionSet,GlobalOptionSet`;

        const token    = await this.connectionManager.getAccessToken();
        const response = await fetch(url, { headers: this.headers(token) });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Dataverse API error ${response.status}: ${body || response.statusText}`);
        }

        const data      = await response.json() as AttributeOptionsResponse;
        const optionSet = data.OptionSet ?? data.GlobalOptionSet;
        return (optionSet?.Options ?? []).map(o => ({
            value: o.Value,
            label: extractLabel(o.Label) || String(o.Value),
        }));
    }

    // Returns the MetadataIds of entities contained in the given solution.
    async getSolutionEntityIds(solutionId: string): Promise<Set<string>> {
        // componenttype 1 = Entity
        const url = this.apiUrl(
            'solutioncomponents',
            '$select=objectid',
            `$filter=_solutionid_value eq '${solutionId}' and componenttype eq 1`,
        );

        const raw = await this.fetchPaged<SolutionComponentResponse>(url);
        return new Set(raw.map(c => c.objectid));
    }

    // ── Web resources ─────────────────────────────────────────────────────

    async getWebResourceIdByName(name: string): Promise<string | undefined> {
        const escaped = name.replace(/'/g, "''");
        const url = this.apiUrl(
            'webresourceset',
            '$select=webresourceid',
            `$filter=name eq '${escaped}'`,
        );

        const data = await this.request<ODataResponse<{ webresourceid: string }>>(url);
        return data?.value[0]?.webresourceid;
    }

    // Returns the base64-encoded content of a web resource as currently published on the server.
    async getWebResourceContent(webResourceId: string): Promise<string> {
        const url = this.apiUrl(`webresourceset(${webResourceId})`, '$select=content');
        const data = await this.request<{ content: string }>(url);
        return data?.content ?? '';
    }

    // Returns the base64-encoded content of a web resource looked up by its unique name,
    // or undefined if no such web resource exists. Used to resolve table icons (IconVectorName).
    async getWebResourceContentByName(name: string): Promise<string | undefined> {
        const escaped = name.replace(/'/g, "''");
        const url = this.apiUrl(
            'webresourceset',
            '$select=content',
            `$filter=name eq '${escaped}'`,
        );

        const data = await this.request<ODataResponse<{ content: string }>>(url);
        return data?.value[0]?.content || undefined;
    }

    // Fetches a system table's built-in icon from the legacy /_imgs/svg_<otc>.svg path and returns it
    // base64-encoded (to match the web-resource icon path). Returns undefined when there's no SVG there —
    // most environments 404 or serve a non-SVG response for codes without a built-in icon.
    async getSystemIconSvg(objectTypeCode: number): Promise<string | undefined> {
        const base  = this.connectionManager.connection!.environmentUrl;
        const token = await this.connectionManager.getAccessToken();

        const response = await fetch(`${base}/_imgs/svg_${objectTypeCode}.svg`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'image/svg+xml' },
        });
        if (!response.ok) { return undefined; }

        // Guard against a 200 sign-in/error HTML page being returned instead of the icon.
        const svg = await response.text();
        if (!/<svg[\s>]/i.test(svg)) { return undefined; }

        return Buffer.from(svg, 'utf8').toString('base64');
    }

    async createWebResource(params: { name: string; displayName: string; type: number; contentBase64: string }): Promise<string> {
        const token = await this.connectionManager.getAccessToken();
        const url   = this.apiUrl('webresourceset');

        const response = await fetch(url, {
            method: 'POST',
            headers: { ...this.headers(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: params.name,
                displayname: params.displayName,
                webresourcetype: params.type,
                content: params.contentBase64,
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Dataverse API error ${response.status}: ${body || response.statusText}`);
        }

        const entityId = response.headers.get('OData-EntityId');
        const match = entityId?.match(/\(([0-9a-fA-F-]{36})\)/);
        if (!match) { throw new Error('Web resource created but its ID could not be determined.'); }
        return match[1];
    }

    async updateWebResourceContent(webResourceId: string, contentBase64: string): Promise<void> {
        const url = this.apiUrl(`webresourceset(${webResourceId})`);
        await this.request(url, { method: 'PATCH', body: { content: contentBase64 } });
    }

    async publishWebResources(webResourceIds: string[]): Promise<void> {
        if (!webResourceIds.length) { return; }

        const url = this.apiUrl('PublishXml');
        const parameterXml =
            `<importexportxml><webresources>${webResourceIds.map(id => `<webresource>${id}</webresource>`).join('')}</webresources></importexportxml>`;

        await this.request(url, { method: 'POST', body: { ParameterXml: parameterXml } });
    }

    async addSolutionComponent(componentId: string, solutionUniqueName: string): Promise<void> {
        const url = this.apiUrl('AddSolutionComponent');
        await this.request(url, {
            method: 'POST',
            body: {
                ComponentId: componentId,
                ComponentType: 61, // Web Resource
                SolutionUniqueName: solutionUniqueName,
                AddRequiredComponents: false,
            },
        });
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private apiUrl(resource: string, ...queryParts: string[]): string {
        const base = this.connectionManager.connection!.environmentUrl;
        const query = queryParts.length ? `?${queryParts.join('&')}` : '';
        return `${base}/api/data/v9.2/${resource}${query}`;
    }

    private async fetchPaged<T>(initialUrl: string): Promise<T[]> {
        const results: T[] = [];
        let url: string | undefined = initialUrl;

        while (url) {
            const token = await this.connectionManager.getAccessToken();
            const response = await fetch(url, { headers: this.headers(token) });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`Dataverse API error ${response.status}: ${body || response.statusText}`);
            }

            const page = await response.json() as ODataResponse<T>;
            results.push(...page.value);
            url = page['@odata.nextLink'];
        }

        return results;
    }

    private async request<T>(url: string, init: { method: string; body?: unknown } = { method: 'GET' }): Promise<T | undefined> {
        const token   = await this.connectionManager.getAccessToken();
        const headers = this.headers(token);
        if (init.body !== undefined) { headers['Content-Type'] = 'application/json'; }

        const response = await fetch(url, {
            method: init.method,
            headers,
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Dataverse API error ${response.status}: ${body || response.statusText}`);
        }

        const text = await response.text();
        return text ? JSON.parse(text) as T : undefined;
    }

    private headers(token: string): Record<string, string> {
        return {
            Authorization: `Bearer ${token}`,
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            Accept: 'application/json',
        };
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Caps a FetchXML query at `maxRows`: drops `page`/`paging-cookie`, keeps a smaller `top`, otherwise replaces
 * `top`/`count` with `count="<maxRows>"` (FetchXML rejects `top` together with `count`).
 */
export function limitFetchXml(fetchXml: string, maxRows: number): string {
    return fetchXml.replace(/<fetch\b([^>]*?)(\/?)>/, (_match, attrs: string, selfClosing: string) => {
        const top = Number(/\btop\s*=\s*["'](\d+)["']/.exec(attrs)?.[1]);
        let kept = attrs.replace(/\s+(page|paging-cookie|count|top)\s*=\s*("[^"]*"|'[^']*')/g, '');
        kept += Number.isFinite(top) && top > 0 && top <= maxRows ? ` top="${top}"` : ` count="${maxRows}"`;
        return `<fetch${kept}${selfClosing}>`;
    });
}

function extractLabel(label: DataverseLabel | undefined): string {
    if (!label) { return ''; }
    return (
        label.UserLocalizedLabel?.Label ??
        label.LocalizedLabels.find(l => l.LanguageCode === 1033)?.Label ??
        label.LocalizedLabels[0]?.Label ??
        ''
    );
}
