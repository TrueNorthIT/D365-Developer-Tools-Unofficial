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

## Requirements

- VS Code 1.85 or later
- A Dataverse / Dynamics 365 environment
- For user auth: an Azure AD application registered with Dataverse API permissions, or use the default Dataverse client ID
- For client credentials: an Azure AD app registration with a client secret and appropriate Dataverse permissions
