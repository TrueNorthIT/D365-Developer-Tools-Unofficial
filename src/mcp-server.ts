#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { z } from 'zod';

import type { EntityDefinition, AttributeDefinition, OptionValue } from './dataverseClient';
import { generateInterface, generateEnum, OPTION_SET_TYPES } from './interfaceGenerator';

// ── Configuration ────────────────────────────────────────────────────────────

const D365_URL           = process.env['D365_URL']?.trim().replace(/\/$/, '');
const D365_TENANT_ID     = process.env['D365_TENANT_ID']?.trim();
const D365_CLIENT_ID     = process.env['D365_CLIENT_ID']?.trim();
const D365_CLIENT_SECRET = process.env['D365_CLIENT_SECRET']?.trim();

if (!D365_URL || !D365_TENANT_ID || !D365_CLIENT_ID || !D365_CLIENT_SECRET) {
    process.stderr.write(
        'D365 MCP Server: Missing required environment variables.\n' +
        'Required: D365_URL, D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET\n',
    );
    process.exit(1);
}

// ── Authentication ───────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | undefined;

async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + 60_000) {
        return cachedToken.token;
    }

    const app = new ConfidentialClientApplication({
        auth: {
            clientId: D365_CLIENT_ID!,
            clientSecret: D365_CLIENT_SECRET!,
            authority: `https://login.microsoftonline.com/${D365_TENANT_ID}`,
        },
    });

    const result = await app.acquireTokenByClientCredential({
        scopes: [`${D365_URL}/.default`],
    });

    if (!result?.accessToken) { throw new Error('Failed to acquire Dataverse access token'); }

    cachedToken = {
        token: result.accessToken,
        expiresAt: result.expiresOn?.getTime() ?? (now + 3_600_000),
    };
    return cachedToken.token;
}

// ── Dataverse HTTP helpers ───────────────────────────────────────────────────

interface ODataPage<T> { value: T[]; '@odata.nextLink'?: string; }

async function dvHeaders(): Promise<Record<string, string>> {
    return {
        Authorization: `Bearer ${await getAccessToken()}`,
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Accept: 'application/json',
    };
}

async function dvFetch<T>(path: string): Promise<T> {
    const response = await fetch(`${D365_URL}/api/data/v9.2/${path}`, { headers: await dvHeaders() });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Dataverse ${response.status}: ${body || response.statusText}`);
    }
    return response.json() as Promise<T>;
}

async function dvFetchAll<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = `${D365_URL}/api/data/v9.2/${path}`;
    while (url) {
        const headers = await dvHeaders();
        const response = await fetch(url, { headers });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Dataverse ${response.status}: ${body || response.statusText}`);
        }
        const page = await response.json() as ODataPage<T>;
        results.push(...page.value);
        url = page['@odata.nextLink'];
    }
    return results;
}

// ── Raw Dataverse response shapes ────────────────────────────────────────────

interface DvLabel {
    UserLocalizedLabel?: { Label: string };
    LocalizedLabels: Array<{ Label: string; LanguageCode: number }>;
}

interface RawEntity {
    MetadataId: string;
    LogicalName: string;
    SchemaName: string;
    DisplayName: DvLabel;
    IsCustomEntity: boolean;
}

interface RawAttribute {
    LogicalName: string;
    SchemaName: string;
    DisplayName: DvLabel;
    AttributeType: string;
    IsPrimaryId: boolean;
    IsPrimaryName: boolean;
}

interface RawSolution {
    solutionid: string;
    uniquename: string;
    friendlyname: string;
}

interface RawSolutionComponent { objectid: string; }

interface RawOptionItem { Value: number; Label: DvLabel; }
interface RawOptionSetData {
    OptionSet?: { Options: RawOptionItem[] };
    GlobalOptionSet?: { Options: RawOptionItem[] };
}

function extractLabel(label: DvLabel | undefined): string {
    if (!label) { return ''; }
    return (
        label.UserLocalizedLabel?.Label ??
        label.LocalizedLabels.find(l => l.LanguageCode === 1033)?.Label ??
        label.LocalizedLabels[0]?.Label ??
        ''
    );
}

const OPTION_SET_CAST: Record<string, string> = {
    Picklist: 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
    State:    'Microsoft.Dynamics.CRM.StateAttributeMetadata',
    Status:   'Microsoft.Dynamics.CRM.StatusAttributeMetadata',
};

// ── Dataverse fetch helpers ──────────────────────────────────────────────────

async function fetchEntities(): Promise<EntityDefinition[]> {
    const raw = await dvFetchAll<RawEntity>(
        'EntityDefinitions?$select=MetadataId,LogicalName,SchemaName,DisplayName,IsCustomEntity',
    );
    return raw.map(e => ({
        metadataId: e.MetadataId,
        logicalName: e.LogicalName,
        schemaName: e.SchemaName,
        displayName: extractLabel(e.DisplayName) || e.SchemaName,
        isCustom: e.IsCustomEntity,
    })).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
}

async function fetchAttributes(entityLogicalName: string): Promise<AttributeDefinition[]> {
    const raw = await dvFetchAll<RawAttribute>(
        `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes` +
        `?$select=LogicalName,SchemaName,DisplayName,AttributeType,IsPrimaryId,IsPrimaryName`,
    );
    return raw.map(a => ({
        logicalName: a.LogicalName,
        schemaName: a.SchemaName,
        displayName: extractLabel(a.DisplayName) || a.SchemaName,
        attributeType: a.AttributeType,
        isPrimaryId: a.IsPrimaryId,
        isPrimaryName: a.IsPrimaryName,
    })).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
}

async function fetchOptionValues(entityLogicalName: string, attributeLogicalName: string, attributeType: string): Promise<OptionValue[]> {
    const cast = OPTION_SET_CAST[attributeType];
    if (!cast) { throw new Error(`${attributeType} is not a supported option-set type`); }

    const data = await dvFetch<RawOptionSetData>(
        `EntityDefinitions(LogicalName='${entityLogicalName}')` +
        `/Attributes(LogicalName='${attributeLogicalName}')/${cast}` +
        `?$expand=OptionSet,GlobalOptionSet`,
    );
    const set = data.OptionSet ?? data.GlobalOptionSet;
    return (set?.Options ?? []).map(o => ({
        value: o.Value,
        label: extractLabel(o.Label) || String(o.Value),
    }));
}

async function fetchSolutionEntityIds(solutionId: string): Promise<Set<string>> {
    const raw = await dvFetchAll<RawSolutionComponent>(
        `solutioncomponents?$select=objectid` +
        `&$filter=_solutionid_value eq '${solutionId}' and componenttype eq 1`,
    );
    return new Set(raw.map(c => c.objectid));
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'd365-dataverse-tools', version: '0.0.1' });

// list_entities ──────────────────────────────────────────────────────────────

server.tool(
    'list_entities',
    'List entities (tables) in the Dataverse environment, optionally filtered to a solution.',
    { solution: z.string().optional().describe('Solution unique name or friendly name (optional)') },
    async ({ solution }) => {
        let entities = await fetchEntities();

        if (solution) {
            const solutions = await dvFetchAll<RawSolution>(
                'solutions?$select=solutionid,uniquename,friendlyname&$filter=isvisible eq true',
            );
            const match = solutions.find(
                s => s.uniquename.toLowerCase() === solution.toLowerCase() ||
                     s.friendlyname.toLowerCase() === solution.toLowerCase(),
            );
            if (!match) {
                const names = solutions.map(s => `${s.friendlyname} (${s.uniquename})`).join(', ');
                return { content: [{ type: 'text' as const, text: `No solution found matching "${solution}".\nAvailable: ${names}` }] };
            }
            const entityIds = await fetchSolutionEntityIds(match.solutionid);
            entities = entities.filter(e => entityIds.has(e.metadataId));
        }

        const text = entities
            .map(e => `${e.logicalName}  (${e.displayName})${e.isCustom ? '  [custom]' : ''}`)
            .join('\n');
        return { content: [{ type: 'text' as const, text }] };
    },
);

// get_entity_attributes ──────────────────────────────────────────────────────

server.tool(
    'get_entity_attributes',
    'Get all attributes (fields) for a Dataverse entity, with their types and flags.',
    { entity_logical_name: z.string().describe('Entity logical name, e.g. "lead", "contact", "account"') },
    async ({ entity_logical_name }) => {
        const attrs = await fetchAttributes(entity_logical_name);
        const text = attrs.map(a => {
            const flags = [
                a.attributeType,
                a.isPrimaryId   && 'Primary ID',
                a.isPrimaryName && 'Primary Name',
            ].filter(Boolean).join('  |  ');
            return `${a.logicalName}  (${a.displayName})  —  ${flags}`;
        }).join('\n');
        return { content: [{ type: 'text' as const, text }] };
    },
);

// get_option_values ──────────────────────────────────────────────────────────

server.tool(
    'get_option_values',
    'Get the option set values for a Picklist, State, or Status attribute.',
    {
        entity_logical_name:    z.string().describe('Entity logical name'),
        attribute_logical_name: z.string().describe('Attribute logical name'),
        attribute_type:         z.enum(['Picklist', 'State', 'Status']).describe('Attribute type'),
    },
    async ({ entity_logical_name, attribute_logical_name, attribute_type }) => {
        const options = await fetchOptionValues(entity_logical_name, attribute_logical_name, attribute_type);
        const text = options.map(o => `${o.value}  —  ${o.label}`).join('\n');
        return { content: [{ type: 'text' as const, text }] };
    },
);

// generate_interface ─────────────────────────────────────────────────────────

server.tool(
    'generate_interface',
    'Generate a TypeScript interface for a Dataverse entity. Option set fields automatically get companion const enums.',
    {
        entity_logical_name: z.string().describe('Entity logical name'),
        fields: z.array(z.string()).optional().describe('Field logical names to include. Omit to include all fields.'),
    },
    async ({ entity_logical_name, fields }) => {
        let attrs = await fetchAttributes(entity_logical_name);

        if (fields?.length) {
            const wanted = new Set(fields);
            attrs = attrs.filter(a => wanted.has(a.logicalName));
        }

        const enumNames = new Map<string, string>();
        const enumBlocks: string[] = [];

        await Promise.all(
            attrs
                .filter(a => OPTION_SET_TYPES.has(a.attributeType))
                .map(async a => {
                    try {
                        const options = await fetchOptionValues(entity_logical_name, a.logicalName, a.attributeType);
                        const block   = generateEnum(a.logicalName, a.displayName, options);
                        const name    = block.match(/export const enum (\w+)/)?.[1];
                        if (name) {
                            enumBlocks.push(block);
                            enumNames.set(a.logicalName, name);
                        }
                    } catch {
                        // fall back to number type for this field
                    }
                }),
        );

        const interfaceBlock = generateInterface(entity_logical_name, entity_logical_name, attrs, enumNames);
        const text = [...enumBlocks, interfaceBlock].join('\n\n');
        return { content: [{ type: 'text' as const, text }] };
    },
);

// generate_enum ──────────────────────────────────────────────────────────────

server.tool(
    'generate_enum',
    'Generate a TypeScript const enum for a Picklist, State, or Status attribute.',
    {
        entity_logical_name:    z.string().describe('Entity logical name'),
        attribute_logical_name: z.string().describe('Attribute logical name'),
        attribute_type:         z.enum(['Picklist', 'State', 'Status']).describe('Attribute type'),
        display_name:           z.string().optional().describe('Display name used to name the enum (falls back to logical name)'),
    },
    async ({ entity_logical_name, attribute_logical_name, attribute_type, display_name }) => {
        const options = await fetchOptionValues(entity_logical_name, attribute_logical_name, attribute_type);
        const text    = generateEnum(attribute_logical_name, display_name ?? attribute_logical_name, options);
        return { content: [{ type: 'text' as const, text }] };
    },
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
    process.stderr.write(`D365 MCP Server fatal error: ${err}\n`);
    process.exit(1);
});
