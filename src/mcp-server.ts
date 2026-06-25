#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { EntityDefinition, AttributeDefinition, OptionValue } from './dataverseClient';
import { generateInterface, generateEnum, OPTION_SET_TYPES } from './interfaceGenerator';
import type { BridgeState } from './mcpBridge';

// ── Bridge connection ────────────────────────────────────────────────────────
// The VS Code extension writes .d365-mcp-bridge (port + nonce) when connected.
// We read it on every request so tokens are always fresh via the extension's MSAL session.

const BRIDGE_FILE = process.env['D365_BRIDGE_FILE']
    ?? path.join(os.homedir(), '.d365-mcp-bridge');

async function getCredentials(): Promise<{ token: string; environmentUrl: string }> {
    let state: BridgeState;
    try {
        state = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')) as BridgeState;
    } catch {
        throw new Error(
            'D365 extension is not connected. Open VS Code, connect to a Dataverse environment ' +
            'via the D365 sidebar, then retry.\n' +
            `(Bridge file expected at: ${BRIDGE_FILE})`,
        );
    }

    const response = await fetch(`http://127.0.0.1:${state.port}/token`, {
        headers: { Authorization: `Bearer ${state.nonce}` },
    });

    if (!response.ok) {
        throw new Error(`Bridge returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<{ token: string; environmentUrl: string }>;
}

// ── Dataverse HTTP helpers ───────────────────────────────────────────────────

interface ODataPage<T> { value: T[]; '@odata.nextLink'?: string; }

async function dvFetch<T>(path: string): Promise<T> {
    const { token, environmentUrl } = await getCredentials();
    const response = await fetch(`${environmentUrl}/api/data/v9.2/${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Dataverse ${response.status}: ${body || response.statusText}`);
    }
    return response.json() as Promise<T>;
}

async function dvFetchAll<T>(resourcePath: string): Promise<T[]> {
    const results: T[] = [];
    const { token, environmentUrl } = await getCredentials();

    const headers = {
        Authorization: `Bearer ${token}`,
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Accept: 'application/json',
    };

    let url: string | undefined = `${environmentUrl}/api/data/v9.2/${resourcePath}`;
    while (url) {
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
interface RawEntity    { MetadataId: string; LogicalName: string; SchemaName: string; DisplayName: DvLabel; IsCustomEntity: boolean; }
interface RawAttribute { LogicalName: string; SchemaName: string; DisplayName: DvLabel; AttributeType: string; IsPrimaryId: boolean; IsPrimaryName: boolean; }
interface RawSolution  { solutionid: string; uniquename: string; friendlyname: string; }
interface RawSolutionComponent { objectid: string; }
interface RawOptionItem { Value: number; Label: DvLabel; }
interface RawOptionSetData {
    OptionSet?:       { Options: RawOptionItem[] };
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
        metadataId:  e.MetadataId,
        logicalName: e.LogicalName,
        schemaName:  e.SchemaName,
        displayName: extractLabel(e.DisplayName) || e.SchemaName,
        isCustom:    e.IsCustomEntity,
    })).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
}

async function fetchAttributes(entityLogicalName: string): Promise<AttributeDefinition[]> {
    const raw = await dvFetchAll<RawAttribute>(
        `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes` +
        `?$select=LogicalName,SchemaName,DisplayName,AttributeType,IsPrimaryId,IsPrimaryName`,
    );
    return raw.map(a => ({
        logicalName:   a.LogicalName,
        schemaName:    a.SchemaName,
        displayName:   extractLabel(a.DisplayName) || a.SchemaName,
        attributeType: a.AttributeType,
        isPrimaryId:   a.IsPrimaryId,
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

        const enumNames  = new Map<string, string>();
        const enumBlocks: string[] = [];

        await Promise.all(
            attrs
                .filter(a => OPTION_SET_TYPES.has(a.attributeType))
                .map(async a => {
                    try {
                        const options = await fetchOptionValues(entity_logical_name, a.logicalName, a.attributeType);
                        const block   = generateEnum(a.logicalName, a.displayName, options);
                        const name    = block.match(/export const enum (\w+)/)?.[1];
                        if (name) { enumBlocks.push(block); enumNames.set(a.logicalName, name); }
                    } catch { /* fall back to number type */ }
                }),
        );

        const interfaceBlock = generateInterface(entity_logical_name, entity_logical_name, attrs, enumNames);
        const text = [...enumBlocks, interfaceBlock].join('\n\n');
        return { content: [{ type: 'text' as const, text }] };
    },
);

server.tool(
    'generate_enum',
    'Generate a TypeScript const enum for a Picklist, State, or Status attribute.',
    {
        entity_logical_name:    z.string().describe('Entity logical name'),
        attribute_logical_name: z.string().describe('Attribute logical name'),
        attribute_type:         z.enum(['Picklist', 'State', 'Status']).describe('Attribute type'),
        display_name:           z.string().optional().describe('Display name for the enum (falls back to logical name)'),
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
