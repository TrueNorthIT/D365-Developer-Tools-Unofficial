import type { ConnectionManager } from './connectionManager';
import { log } from './logger';
import { decompressRibbonPayload } from './ribbon/decompressRibbon';

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

// Mirrors (a useful subset of) the Microsoft.Dynamics.CRM.RibbonLocationFilters Web API enum —
// 'All' merges every location, the other three scope the request to just that ribbon.
export type RibbonLocationFilter = 'All' | 'Form' | 'HomepageGrid' | 'SubGrid';

// ── Client ──────────────────────────────────────────────────────────────────

export class DataverseClient {
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

    // Resolves a ribbon control's icon reference to a data: URI the webview can render directly.
    // Two reference shapes appear in ribbon XML: `$webresource:<name>` (custom icons, resolved via
    // the same web resource lookup table icons use) and a relative system path like
    // `/_imgs/ribbon/DeleteSelected_32.png` (built-in icons, fetched directly with the same
    // bearer-token pattern as getSystemIconSvg). Returns undefined for anything else or on failure.
    async getRibbonImageContent(ref: string): Promise<string | undefined> {
        if (ref.startsWith('$webresource:')) {
            const name = ref.slice('$webresource:'.length);
            const base64 = await this.getWebResourceContentByName(name);
            return base64 ? `data:${mimeTypeFor(name)};base64,${base64}` : undefined;
        }

        if (!ref.startsWith('/')) { return undefined; }

        const base = this.connectionManager.connection!.environmentUrl;
        const token = await this.connectionManager.getAccessToken();

        const response = await fetch(`${base}${ref}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) { return undefined; }

        const buf = Buffer.from(await response.arrayBuffer());
        return `data:${mimeTypeFor(ref)};base64,${buf.toString('base64')}`;
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

    // ── Ribbon ────────────────────────────────────────────────────────────

    // Retrieves the ribbon for an entity, scoped to a specific UI location — the same source
    // Ribbon Workbench reads from. The response is a base64-encoded, compressed XML document
    // (`<RibbonDefinitions><RibbonXml>…</RibbonXml><LocLabels>…</LocLabels></RibbonDefinitions>`) —
    // see decompressRibbonPayload for why the compression format itself isn't assumed.
    async getEntityRibbonXml(entityLogicalName: string, locationFilter: RibbonLocationFilter = 'All'): Promise<string> {
        const url = this.apiUrl(
            `RetrieveEntityRibbon(EntityName='${entityLogicalName}',RibbonLocationFilter=Microsoft.Dynamics.CRM.RibbonLocationFilters'${locationFilter}')`,
        );
        log(`DataverseClient.getEntityRibbonXml: GET ${url}`);

        const data = await this.request<{ CompressedEntityXml: string }>(url);
        const compressed = data?.CompressedEntityXml;
        if (!compressed) { throw new Error(`No ribbon XML returned for entity '${entityLogicalName}'.`); }

        const decompressed = decompressRibbonPayload(compressed);
        const xml = decodeXmlBuffer(decompressed);
        log(`DataverseClient.getEntityRibbonXml: ${compressed.length} base64 chars -> ${decompressed.length} decompressed bytes -> ${xml.length} chars decoded`);
        log(`DataverseClient.getEntityRibbonXml: decoded XML preview: ${xml.slice(0, 300).replace(/\s+/g, ' ')}${xml.length > 300 ? '…' : ''}`);
        return xml;
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

// Ribbon XML exports aren't guaranteed to be UTF-8 (CRM's ribbon tooling frequently emits
// UTF-16), so decode based on the BOM actually present rather than assuming one encoding.
function decodeXmlBuffer(buf: Buffer): string {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf.subarray(2));
        swapped.swap16();
        return swapped.toString('utf16le');
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return buf.subarray(3).toString('utf8');
    }
    return buf.toString('utf8');
}

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function mimeTypeFor(pathOrName: string): string {
    const match = /\.[a-z0-9]+$/i.exec(pathOrName);
    return (match && MIME_TYPES_BY_EXTENSION[match[0].toLowerCase()]) || 'image/png';
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
