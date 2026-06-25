# D365 Dataverse Tools

A VS Code extension for TypeScript development against Dynamics 365 / Dataverse. Browse entities and attributes, generate typed interfaces, and produce `const enum`s for option sets — all without leaving the editor.

## Features

### Entity Explorer

A sidebar panel (D365 icon in the Activity Bar) that connects to your Dataverse environment and lets you explore its metadata.

- Lists all entities, sortable and filterable by solution
- Expand any entity to see its attributes, types, and whether each field is the primary ID or primary name
- Right-click an entity to generate a TypeScript interface
- Right-click a Picklist, State, or Status field to generate a standalone `const enum`

### TypeScript Interface Generation

Right-click an entity in the explorer (or run **D365: Generate TypeScript Interface** from the command palette) to generate a typed interface for it.

You'll be prompted to select which fields to include. The output is opened directly in the editor as a new TypeScript file.

- Fields are typed appropriately (`string`, `number`, `boolean`, `string | null` for lookups)
- Lookup fields include a JSDoc note that the Web API returns them as `_logicalname_value`
- DateTime fields are typed `string` with an ISO 8601 note
- Picklist / State / Status fields automatically have their option values fetched and a matching `const enum` generated alongside the interface

**Example output:**

```typescript
export const enum LeadStatusCode {
    New = 1,
    Contacted = 2,
    Qualified = 3,
}

// Lead (lead)
export interface Lead {
    leadid: string;
    /** Primary Name */
    fullname: string;
    statuscode: LeadStatusCode;
    /** lookup — field appears as _logicalname_value in API responses */
    _ownerid_value: string | null;
}
```

### Enum Generation

Right-click any Picklist, State, or Status attribute in the explorer and choose **Make Enum**. The extension fetches the option set values from Dataverse and opens a `const enum` ready to copy into your project.

```typescript
export const enum LeadStatusCode {
    New = 1,
    Contacted = 2,
    Qualified = 3,
}
```

### Connection Management

- **Connect** — prompts for environment URL and authentication method, then validates connectivity via WhoAmI
- **Disconnect** — clears the stored session
- **Auto-restore** — the last connection is silently restored when the workspace opens; the sidebar shows a spinner while this is in progress and a Connect prompt if restore fails

Authentication options:

| Mode | Description |
|---|---|
| User account | Interactive sign-in via Microsoft account (MSAL device flow) |
| Client credentials | App-only, using an Azure AD client ID and secret |

Client secrets are stored in VS Code's secret storage (OS keychain), never in plain text.

### Browse Entity Fields

The **Browse Entity Fields** title bar button (or **D365: Browse Entity Fields** from the palette) opens a searchable quick-pick showing all attributes for any entity — useful for quickly looking up a field name or type without generating any code.

## Title Bar Actions

The sidebar title bar shows context-sensitive actions:

| Icon | Command | Shown when |
|---|---|---|
| `$(plug)` | Connect | Disconnected |
| `$(debug-disconnect)` | Disconnect | Connected |
| `$(refresh)` | Refresh Entities | Connected |
| `$(list-flat)` | Browse Entity Fields | Connected |

## Extension Settings

| Setting | Description | Default |
|---|---|---|
| `d365.environmentUrl` | Dataverse environment URL, e.g. `https://yourorg.crm11.dynamics.com` | — |
| `d365.tenantId` | Azure AD tenant ID. Leave blank to auto-discover from the environment URL | — |
| `d365.clientId` | Azure AD application (client) ID | — |
| `d365.authMode` | `user` or `clientCredentials`. Leave blank to be prompted each time | — |

## Claude / AI Integration (MCP Server)

The extension ships an MCP (Model Context Protocol) server so Claude can query your live Dataverse schema while helping you write TypeScript scripts. When the server is running, Claude can look up entity shapes, field types, and option set values in real time — no copy-pasting schema details into the chat.

### Available tools

| Tool | Description |
|---|---|
| `list_entities` | List all entities, optionally filtered to a solution |
| `get_entity_attributes` | Get all fields for an entity with their types |
| `get_option_values` | Get the numeric values and labels for a Picklist, State, or Status field |
| `generate_interface` | Generate a TypeScript interface (with auto-enums for option set fields) |
| `generate_enum` | Generate a `const enum` for a single option set field |

### Setup

The MCP server piggybacks on the VS Code extension's active connection — no separate credentials needed. Connect to your environment in the sidebar first, then Claude can use the same session.

1. **Build the server** — compiled automatically alongside the extension:
   ```bash
   npm run compile
   ```

2. **Create `.mcp.json`** in the workspace root (copy from `.mcp.json.example`):
   ```json
   {
     "mcpServers": {
       "d365": {
         "command": "node",
         "args": ["${workspaceFolder}/out/mcp-server.js"]
       }
     }
   }
   ```
   No credentials in the file — the extension handles all authentication.

3. **Connect in VS Code** — use the Connect button in the D365 sidebar. The extension starts a local bridge server that the MCP server reads tokens from.

4. **Restart Claude Code** — it picks up `.mcp.json` automatically. Run `/mcp` to verify the `d365` server is connected.

If Claude reports the extension is not connected, check the D365 sidebar — it needs an active connection before the bridge is available.

### Example usage

Once connected, Claude can answer questions like:

> *"Generate a TypeScript interface for the `lead` entity, only including the name, status, owner, and created date fields."*

Claude will call `get_entity_attributes` and `generate_interface` against your live environment and return ready-to-use code.

## Requirements

- VS Code 1.85 or later
- A Dataverse / Dynamics 365 environment
- For user auth: an Azure AD application registered with Dataverse API permissions, or use the default Dataverse client ID
- For client credentials: an Azure AD app registration with a client secret and appropriate Dataverse permissions
