import { XMLParser } from 'fast-xml-parser';
import type { ConnectionManager } from './connectionManager';
import { log } from './logger';
import { decompressRibbonPayload } from './ribbon/decompressRibbon';
import { readZipEntry } from './ribbon/zip';
import { extractRibbonDiffXmlFromCustomizations } from './ribbon/solutionPackage';

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

interface EntityRibbonMetadataResponse {
    MetadataId: string;
    SchemaName: string;
    DisplayName: DataverseLabel;
    DisplayCollectionName: DataverseLabel;
    Description: DataverseLabel;
    EntitySetName: string;
    OwnershipType: string | null;
    IntroducedVersion: string | null;
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

interface PublisherResponse {
    publisherid: string;
    uniquename: string;
    friendlyname: string;
}

interface ImportJobResponse {
    completedon: string | null;
    data: string | null;
}

interface SolutionHistoryResponse {
    msdyn_status: number;
    msdyn_result: boolean | null;
    msdyn_exceptionmessage: string | null;
}

// msdyn_status choice values (Started/Completed/Queued -- yes, Completed is 1 and Queued is 2,
// not the more intuitive Started/Queued/Completed ordering) -- see msdyn_solutionhistory docs.
const SOLUTION_HISTORY_STATUS = ['Started', 'Completed', 'Queued'] as const;

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

// The subset of an entity's metadata that identifies it -- used to build the <EntityInfo> block a
// ribbon-only solution import apparently needs (see solutionPackage.ts). Fetched live and used
// verbatim, never guessed, precisely because this is metadata that could matter if it were wrong.
export interface EntityRibbonMetadata {
    /** The entity's MetadataId -- used as the ComponentId when adding it to a solution (e.g. for
     *  getEntityCurrentRibbonDiffXml's export round-trip), distinct from any data record id. */
    metadataId: string;
    schemaName: string;
    displayName: string;
    displayCollectionName: string;
    description: string;
    entitySetName: string;
    /** e.g. "UserOwned", "OrganizationOwned" -- the OwnershipTypes enum member name Dataverse itself returned. */
    ownershipType: string;
    introducedVersion: string;
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

export interface Publisher {
    publisherId: string;
    uniqueName: string;
    friendlyName: string;
}

export interface ImportJobResult {
    completed: boolean;
    success: boolean;
    errorText?: string;
    /** A non-fatal note Dataverse reported despite the import succeeding overall (`succeeded="warning"`) — see getImportJobResult. */
    warningText?: string;
}

export interface RibbonMetadataGenerationStatus {
    status: 'Started' | 'Completed' | 'Queued';
    /** Only present once status is 'Completed'. */
    result?: 'Success' | 'Failure';
    /** Populated by Dataverse when result is 'Failure'. */
    exceptionMessage?: string;
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

    /** The connected environment's URL, or undefined if not currently connected -- e.g. for keying a
     *  per-environment cache without a caller needing the whole ConnectionManager (see RibbonLabelCache). */
    get environmentUrl(): string | undefined {
        return this.connectionManager.connection?.environmentUrl;
    }

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

    // Live identity metadata for an entity -- used to build the <EntityInfo> block a ribbon-only
    // solution import needs (see solutionPackage.ts / getEntityRibbonMetadata's doc comment). Only
    // fields this method is confident it can map correctly from the Web API are fetched; anything
    // else in a real EntityInfo export falls back to a fixed, verified-safe default rather than a
    // guessed live value (see solutionPackage.ts).
    async getEntityRibbonMetadata(entityLogicalName: string): Promise<EntityRibbonMetadata> {
        const url = this.apiUrl(
            `EntityDefinitions(LogicalName='${entityLogicalName}')`,
            '$select=MetadataId,SchemaName,DisplayName,DisplayCollectionName,Description,EntitySetName,OwnershipType,IntroducedVersion',
        );

        const data = await this.request<EntityRibbonMetadataResponse>(url);
        if (!data) { throw new Error(`No metadata returned for entity '${entityLogicalName}'.`); }

        return {
            metadataId: data.MetadataId,
            schemaName: data.SchemaName,
            displayName: extractLabel(data.DisplayName) || data.SchemaName,
            displayCollectionName: extractLabel(data.DisplayCollectionName) || data.SchemaName,
            description: extractLabel(data.Description),
            entitySetName: data.EntitySetName,
            ownershipType: data.OwnershipType || 'UserOwned',
            introducedVersion: data.IntroducedVersion || '1.0',
        };
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

    // isreadonly filters out Microsoft-owned/system publishers (e.g. "MicrosoftCorporation") that
    // can't meaningfully be used as the publisher of a solution the user creates.
    async getPublishers(): Promise<Publisher[]> {
        const url = this.apiUrl(
            'publishers',
            '$select=publisherid,uniquename,friendlyname',
            '$filter=isreadonly eq false',
            '$orderby=friendlyname',
        );

        const raw = await this.fetchPaged<PublisherResponse>(url);
        return raw.map(p => ({
            publisherId: p.publisherid,
            uniqueName: p.uniquename,
            friendlyName: p.friendlyname,
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

    // Web resource name search-as-you-type (the Ribbon Editor's icon/library fields). Capped and
    // ordered by name rather than paged through fetchPaged -- this backs a live autocomplete
    // dropdown, not a full listing.
    async searchWebResources(query: string): Promise<string[]> {
        const trimmed = query.trim();
        const escaped = trimmed.replace(/'/g, "''");
        const url = this.apiUrl(
            'webresourceset',
            '$select=name',
            '$orderby=name',
            '$top=25',
            ...(trimmed ? [`$filter=contains(name,'${escaped}')`] : []),
        );

        const data = await this.request<ODataResponse<{ name: string }>>(url);
        return (data?.value ?? []).map(r => r.name);
    }

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
    // Three reference shapes appear in ribbon XML: `$webresource:<name>` (custom icons, resolved via
    // the same web resource lookup table icons use), a relative system path like
    // `/_imgs/ribbon/DeleteSelected_32.png` (built-in icons, fetched directly with the same
    // bearer-token pattern as getSystemIconSvg), and a bare web resource name -- how a custom
    // ModernImage (the modern/Unified Interface command bar's icon) is stored. Most ModernImage
    // values are actually one of Dataverse's built-in Fluent icon names rather than a web resource,
    // so that lookup simply finds nothing and this returns undefined, same as any other unresolvable
    // reference or failed fetch.
    async getRibbonImageContent(ref: string): Promise<string | undefined> {
        if (ref.startsWith('$webresource:')) {
            const name = ref.slice('$webresource:'.length);
            const base64 = await this.getWebResourceContentByName(name);
            return base64 ? `data:${sniffImageMimeType(base64)};base64,${base64}` : undefined;
        }

        if (ref.startsWith('/')) {
            const base = this.connectionManager.connection!.environmentUrl;
            const token = await this.connectionManager.getAccessToken();

            const response = await fetch(`${base}${ref}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) { return undefined; }

            const buf = Buffer.from(await response.arrayBuffer());
            return `data:${mimeTypeFor(ref)};base64,${buf.toString('base64')}`;
        }

        const base64 = await this.getWebResourceContentByName(ref);
        return base64 ? `data:${sniffImageMimeType(base64)};base64,${base64}` : undefined;
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

    async addSolutionComponent(componentId: string, solutionUniqueName: string, componentType = 61 /* Web Resource */): Promise<void> {
        const url = this.apiUrl('AddSolutionComponent');
        await this.request(url, {
            method: 'POST',
            body: {
                ComponentId: componentId,
                ComponentType: componentType,
                SolutionUniqueName: solutionUniqueName,
                AddRequiredComponents: false,
                // Entity (1) needs its subcomponents included, or its Ribbon Customization -- what
                // getEntityCurrentRibbonDiffXml actually wants out of the export below -- is left out.
                DoNotIncludeSubcomponents: false,
            },
        });
    }

    // ── Solution import (publishToDynamics — ribbonEditorPanel.ts) ──────────

    // Imports a solution zip (see solutionPackage.ts). `importJobId` is caller-generated so the
    // caller can immediately start polling getImportJobResult with it -- the action call itself
    // completes synchronously, but ImportJob's own `data` column is the documented way to confirm
    // success/failure per component, not just "the HTTP call didn't throw".
    async importSolution(zipBase64: string, importJobId: string): Promise<void> {
        const url = this.apiUrl('ImportSolution');
        await this.request(url, {
            method: 'POST',
            body: {
                CustomizationFile: zipBase64,
                // Every publish targets a control this same feature (or the user, editing again)
                // may well have already customized on a *previous* publish -- since each import uses
                // a brand-new throwaway solution, that prior customization is, from Dataverse's
                // perspective, "someone else's" existing unmanaged customization. `false` here tells
                // it not to overwrite that, which can silently drop the re-add half of a modified
                // control's diff (hide applies, re-add doesn't) while still reporting success. `true`
                // ensures this import's version always wins, which is exactly what we want when it's
                // our own tool re-publishing an edit to something it already customized.
                OverwriteUnmanagedCustomizations: true,
                PublishWorkflows: false,
                ImportJobId: importJobId,
            },
        });
    }

    // Reads back the result of a prior importSolution call. `completed: false` means the job hasn't
    // finished yet (completedon is still null) -- the caller should wait briefly and poll again.
    async getImportJobResult(importJobId: string): Promise<ImportJobResult> {
        const url = this.apiUrl(`importjobs(${importJobId})`, '$select=completedon,data');
        const job = await this.request<ImportJobResponse>(url);

        if (!job?.completedon || !job.data) { return { completed: false, success: false }; }

        // `data` is an XML document rooted at <importexportxml succeeded="true|false|warning" ...>,
        // with a nested breakdown by component/subhandler each carrying their own <result result=
        // "success|failure" .../> node (confirmed against a real import: a ribbon change succeeded
        // -- <entitySubhandlers><entityRibbon processed="true"><result result="success" /> -- while a
        // separate, generic entity-level dependency check for the same entity logged its own
        // non-fatal <result result="failure" errortext="The ribbon item ... is dependent on ..."/>
        // note without actually blocking anything). The root `succeeded` attribute is the
        // authoritative overall verdict, matching what Dataverse's own import history shows -- NOT
        // "does some `result` node somewhere in this tree say failure", which this used to check and
        // which misreported that exact non-fatal note as a hard failure.
        const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(job.data) as Record<string, unknown>;
        const root = asRecord(parsed.importexportxml);
        const succeeded = root?.['@_succeeded'];

        if (succeeded === 'false' || succeeded === undefined) {
            const failure = findFailedResult(parsed);
            return { completed: true, success: false, errorText: failure?.['@_errortext'] || failure?.['@_errorcode'] || 'Import failed.' };
        }

        // succeeded === 'true' or 'warning' -- both treated as success, but surface a warning's note
        // (if any) so the caller can tell the user what Dataverse flagged without treating it as fatal.
        const warning = succeeded === 'warning' ? findFailedResult(parsed) : undefined;
        return { completed: true, success: true, warningText: warning?.['@_errortext'] || undefined };
    }

    async publishEntity(entityLogicalName: string): Promise<void> {
        const url = this.apiUrl('PublishXml');
        const parameterXml = `<importexportxml><entities><entity>${escapeXmlText(entityLogicalName)}</entity></entities></importexportxml>`;
        await this.request(url, { method: 'POST', body: { ParameterXml: parameterXml } });
    }

    async deleteSolution(solutionId: string): Promise<void> {
        const url = this.apiUrl(`solutions(${solutionId})`);
        await this.request(url, { method: 'DELETE' });
    }

    async createSolution(publisherId: string, uniqueName: string, friendlyName: string): Promise<string> {
        const url = this.apiUrl('solutions');
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...this.headers(await this.connectionManager.getAccessToken()), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uniquename: uniqueName,
                friendlyname: friendlyName,
                version: '1.0.0.0',
                'publisherid@odata.bind': `/publishers(${publisherId})`,
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Dataverse API error ${response.status}: ${body || response.statusText}`);
        }

        const entityId = response.headers.get('OData-EntityId');
        const match = entityId?.match(/\(([0-9a-fA-F-]{36})\)/);
        if (!match) { throw new Error('Solution created but its ID could not be determined.'); }
        return match[1];
    }

    // Returns the raw bytes of an unmanaged export of the given solution (ExportSolutionFile is
    // base64-encoded in the JSON response).
    async exportSolution(uniqueName: string): Promise<Buffer> {
        const url = this.apiUrl('ExportSolution');
        const data = await this.request<{ ExportSolutionFile: string }>(url, {
            method: 'POST',
            body: { SolutionName: uniqueName, Managed: false },
        });
        if (!data?.ExportSolutionFile) { throw new Error(`ExportSolution returned no file for solution '${uniqueName}'.`); }
        return Buffer.from(data.ExportSolutionFile, 'base64');
    }

    // Fetches the entity's ACTUAL current RibbonDiffXml -- not the merged/effective ribbon
    // RetrieveEntityRibbon returns -- by round-tripping through a real solution export, the same way
    // a developer manually preparing to hand-edit a ribbon would (see Microsoft's own "Export,
    // prepare to edit, and import the ribbon" guidance). There's no direct Web API property for this;
    // exporting is the only way to get it byte-for-byte as Dataverse actually has it stored. Used by
    // publishToDynamics (ribbonEditorPanel.ts) via mergeRibbonDiffXml so a publish only replaces the
    // fragments this session actually touched, instead of the entity's entire ribbon customization.
    //
    // The temporary solution this creates is deleted again before returning (best-effort) -- same
    // "temporary" caveat as the publish-side temp solution: deleting it doesn't undo anything, it's
    // just solution-list bookkeeping. Returns undefined if the entity has no existing customization
    // (a brand-new entity, or one whose ribbon has never been touched).
    async getEntityCurrentRibbonDiffXml(entityLogicalName: string, entityMetadataId: string, publisherId: string): Promise<string | undefined> {
        const solutionUniqueName = `d365vscodetools_ribbonexport_${Date.now()}`;
        const solutionId = await this.createSolution(publisherId, solutionUniqueName, `Ribbon export: ${entityLogicalName} (temporary)`);

        try {
            await this.addSolutionComponent(entityMetadataId, solutionUniqueName, 1 /* Entity */);
            const zip = await this.exportSolution(solutionUniqueName);
            const customizationsXmlBuffer = readZipEntry(zip, 'customizations.xml');
            if (!customizationsXmlBuffer) { throw new Error("Exported solution zip has no 'customizations.xml' entry."); }

            const customizationsXml = decodeXmlBuffer(customizationsXmlBuffer);
            return extractRibbonDiffXmlFromCustomizations(customizationsXml);
        } finally {
            await this.deleteSolution(solutionId).catch(err => log(`getEntityCurrentRibbonDiffXml: could not delete temporary solution '${solutionUniqueName}': ${err}`));
        }
    }

    // ── Ribbon metadata regeneration (regenerateRibbonMetadata — ribbonEditorPanel.ts) ──────
    //
    // Confirmed by capturing the exact request Command Checker's own "Regenerate ribbon metadata"
    // button makes: an unbound POST to this action with an EMPTY body -- it takes no parameters, so
    // there is no way to scope this to one entity; it always regenerates for the whole environment,
    // matching its own name literally. Its response is just `{"StatusCode":201}`, no operation id to
    // poll -- and the table Microsoft's own troubleshooting docs cite for *per-entity* progress
    // (documented as RibbonMetadataSetToProcess) isn't actually reachable through the public Web
    // API -- confirmed via a live 404 across both v9.0 and v9.2, despite matching the documented
    // entity set name exactly.
    async regenerateAllRibbonMetadata(): Promise<void> {
        const url = this.apiUrl('RegenerateRibbonMetadataForAllEntities');
        await this.request(url, { method: 'POST' });
    }

    // Tracks the *environment-level* operation this creates instead -- the same one Microsoft's own
    // docs say to watch on the Solutions History page (Settings > Solutions > Solutions History).
    // That page reads from Solution History (msdyn_solutionhistory / msdyn_solutionhistories), a
    // real, documented, RetrieveMultiple-capable table distinct from the per-entity queue table
    // above; msdyn_operation choice value 7 is "RibbonMetadataGeneration". Callers should capture
    // "now" *before* calling regenerateAllRibbonMetadata and pass it here so a previous run's row
    // isn't mistaken for this one. Returns undefined if no matching row exists yet (row creation
    // isn't guaranteed to be instantaneous) -- callers should keep polling briefly in that case.
    async getLatestRibbonMetadataGenerationRun(sinceUtc: Date): Promise<RibbonMetadataGenerationStatus | undefined> {
        const url = this.apiUrl(
            'msdyn_solutionhistories',
            '$select=msdyn_status,msdyn_result,msdyn_exceptionmessage',
            `$filter=msdyn_operation eq 7 and msdyn_starttime ge ${sinceUtc.toISOString()}`,
            '$orderby=msdyn_starttime desc',
            '$top=1',
        );
        const data = await this.request<ODataResponse<SolutionHistoryResponse>>(url);
        const row = data?.value[0];
        if (!row) { return undefined; }

        return {
            status: SOLUTION_HISTORY_STATUS[row.msdyn_status] ?? 'Started',
            result: row.msdyn_result === null ? undefined : (row.msdyn_result ? 'Success' : 'Failure'),
            exceptionMessage: row.msdyn_exceptionmessage ?? undefined,
        };
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

// A web resource's `name` doesn't have to end in an extension matching its actual content (unlike a
// /_imgs/... system path, which is a real URL and so reliably does) -- guessing the mime type from it
// via mimeTypeFor silently mislabels anything named without one (defaulting to image/png), producing a
// data: URI the browser can't decode and renders as a broken image, even though the exact same web
// resource displays fine in Dynamics itself (which resolves content type from the record's own
// webresourcetype column, not the name string). Sniffing the actual bytes -- same technique as
// src/webview/helpers.ts's sniffRasterMimeType, for the same reason -- works regardless of naming.
function sniffImageMimeType(base64: string): string {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) { return 'image/png'; }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { return 'image/jpeg'; }
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) { return 'image/gif'; }
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) { return 'image/x-icon'; }
    return 'image/svg+xml'; // anything else -- ribbon icons that aren't raster are always vector/XML
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

// Recursively searches a parsed ImportJob `data` document for the first `result` node whose
// `@_result` attribute is "failure" -- these can appear at any depth (solution-level, then per
// component type, then per component), and only failing ones carry `@_errortext`/`@_errorcode`.
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findFailedResult(node: unknown): Record<string, string> | undefined {
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findFailedResult(item);
            if (found) { return found; }
        }
        return undefined;
    }
    if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (obj.result !== undefined) {
            const results = Array.isArray(obj.result) ? obj.result : [obj.result];
            for (const r of results) {
                if (r && typeof r === 'object' && (r as Record<string, unknown>)['@_result'] === 'failure') {
                    return r as Record<string, string>;
                }
            }
        }
        for (const value of Object.values(obj)) {
            const found = findFailedResult(value);
            if (found) { return found; }
        }
    }
    return undefined;
}

function escapeXmlText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
