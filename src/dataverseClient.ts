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

// ── Client ──────────────────────────────────────────────────────────────────

export class DataverseClient {
    constructor(private readonly connectionManager: ConnectionManager) {}

    async getEntities(): Promise<EntityDefinition[]> {
        const url = this.apiUrl(
            'EntityDefinitions',
            '$select=MetadataId,LogicalName,SchemaName,DisplayName,IsCustomEntity',
        );

        const raw = await this.fetchPaged<EntityDefinitionResponse>(url);
        return raw.map(e => ({
            metadataId: e.MetadataId,
            logicalName: e.LogicalName,
            schemaName: e.SchemaName,
            displayName: extractLabel(e.DisplayName) || e.SchemaName,
            isCustom: e.IsCustomEntity,
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

function extractLabel(label: DataverseLabel | undefined): string {
    if (!label) { return ''; }
    return (
        label.UserLocalizedLabel?.Label ??
        label.LocalizedLabels.find(l => l.LanguageCode === 1033)?.Label ??
        label.LocalizedLabels[0]?.Label ??
        ''
    );
}
