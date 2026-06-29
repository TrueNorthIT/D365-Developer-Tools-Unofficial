# D365 Developer Tools (Unofficial)

A VS Code extension for TypeScript development against Dynamics 365 / Dataverse. Browse entities and attributes, generate typed interfaces and `const enum`s for option sets, and get IntelliSense-driven schema generation — all without leaving the editor.

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

- Fields are typed appropriately (`string`, `number`, `boolean`)
- Lookup / Customer / Owner fields use the actual Web API key (`_logicalname_value`) with an optional companion annotation field for the display name
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
    _ownerid_value: string | null;
    '_ownerid_value@OData.Community.Display.V1.FormattedValue'?: string;
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

### IntelliSense Integration

Generate interfaces directly in your TypeScript files without touching the sidebar.

**Option 1 — type `d365`**

Start typing `d365` anywhere in a `.ts` or `.js` file and two items appear in the autocomplete dropdown:

- **D365: Generate interface…** — prompts for an entity, then inserts all fields
- **D365: Generate interface (select fields…)** — prompts for an entity, then lets you pick which fields to include

**Option 2 — trigger comment**

Write a trigger comment with the entity name already known, then use the lightbulb (`Ctrl+.`):

```typescript
// @d365 lead
```

The same two options appear. Accepting either replaces the comment with the generated code in-place.

Both paths fetch option set values automatically and produce `const enum`s alongside the interface.

### Connection Management

- **Connect** — prompts for environment URL and authentication method, then validates connectivity via WhoAmI
- **Disconnect** — clears the stored session
- **Auto-restore** — the extension activates in the background when VS Code opens and silently restores the last connection; the sidebar shows a spinner while this is in progress and a reconnect prompt if it fails

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

No credentials or manual config needed — the MCP server uses your existing VS Code session.

1. **Connect in the D365 sidebar** — authenticate as normal.
2. **Restart Claude Code** — on first activation the extension detects Claude Code and writes `.mcp.json` automatically. A notification confirms when this happens.
3. **Run `/mcp`** in Claude Code to confirm the `d365` server is listed as connected.

That's it. The extension starts a local token-vending bridge (`~/.d365-mcp-bridge`) whenever you're connected; the MCP server reads from it so Claude always has a fresh token without storing any credentials.

> If the `d365` server shows as disconnected in `/mcp`, make sure the D365 sidebar is connected in VS Code first.

### Example usage

Once connected, Claude can answer questions like:

> *"Generate a TypeScript interface for the `lead` entity, only including the name, status, owner, and created date fields."*

Claude will call `get_entity_attributes` and `generate_interface` against your live environment and return ready-to-use code.

## Requirements

- VS Code 1.85 or later
- A Dataverse / Dynamics 365 environment
- For user auth: an Azure AD application registered with Dataverse API permissions, or use the default Dataverse client ID
- For client credentials: an Azure AD app registration with a client secret and appropriate Dataverse permissions
