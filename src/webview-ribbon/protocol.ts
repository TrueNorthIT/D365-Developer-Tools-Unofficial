// Message protocol between the extension host (ribbonEditorPanel.ts) and this webview.
// Deliberately separate from src/webview/protocol.ts (the sidebar's) — this panel pushes one full
// model snapshot and gets edit-tracked snapshots back, rather than the sidebar's incremental
// event/RPC mix, so sharing a protocol type would only add confusion.
//
// A plain, JSON-serializable mirror of src/ribbon/ribbonModel.ts. Kept webview-local (no `vscode`
// or extension-host imports) so the webview tsconfig doesn't need to resolve Node types.

export type RibbonNodeStatus = 'unchanged' | 'added' | 'modified' | 'deleted';

export interface RibbonControl {
  kind: 'Button' | 'SplitButton' | 'FlyoutAnchor' | 'MenuSection';
  id: string;
  label: string;
  toolTipTitle: string;
  toolTipDescription: string;
  image16?: string;
  image32?: string;
  modernImage?: string;
  commandId?: string;
  /** This control's Sequence attribute in the merged/effective ribbon -- see ribbonModel.ts's copy of
   *  this type for the full explanation. Only reorderControl (ribbonState.ts) ever reassigns it. */
  sequence?: string;
  controls?: RibbonControl[];
  status: RibbonNodeStatus;
}

export interface RibbonGroup {
  id: string;
  title: string;
  sequence?: string;
  controls: RibbonControl[];
  status: RibbonNodeStatus;
}

export interface RibbonTab {
  id: string;
  title: string;
  sequence?: string;
  groups: RibbonGroup[];
  status: RibbonNodeStatus;
}

export type RibbonActionParameter =
  | { type: 'BoolParameter'; value: boolean }
  | { type: 'CrmParameter'; value: string }
  | { type: 'DecimalParameter'; value: string }
  | { type: 'IntParameter'; value: string }
  | { type: 'StringParameter'; value: string };

export type RibbonAction =
  | { type: 'JavaScriptFunction'; library: string; functionName: string; params: RibbonActionParameter[] }
  | { type: 'Url'; address: string }
  | { type: 'Raw'; xml: string };

export interface RibbonCommandDefinition {
  id: string;
  enableRules: string[];
  displayRules: string[];
  actions: RibbonAction[];
  status: RibbonNodeStatus;
}

export interface RibbonRuleRaw {
  id: string;
  xml: string;
  status: RibbonNodeStatus;
}

export interface RibbonModel {
  tabs: RibbonTab[];
  commandDefinitions: RibbonCommandDefinition[];
  enableRules: RibbonRuleRaw[];
  displayRules: RibbonRuleRaw[];
  locLabels: Record<string, string>;
}

// ── Events: Extension → Webview ───────────────────────────────────────────────
export type InboundMessage =
  | { type: 'ribbonModel'; entityLogicalName: string; entityDisplayName: string; ribbonLocationLabel: string; publisherPrefix: string; model: RibbonModel }
  | { type: 'ribbonError'; message: string }
  | { type: 'ribbonLoading' };

// ── Events: Webview → Extension ───────────────────────────────────────────────
export type OutboundMessage =
  | { type: 'ready' }
  | { type: 'reloadFromServer' }
  | { type: 'exportRibbonDiffXml'; model: RibbonModel }
  | { type: 'publishToDynamics'; model: RibbonModel }
  | { type: 'regenerateRibbonMetadata' };

// ── RPC: request/response over the same transport (icon fetching) ───────────
// Mirrors src/webview/protocol.ts's RpcRequestMap shape — see src/webview/rpc.ts for the transport.
export interface RpcRequestMap {
  /** Resolves a ribbon control's image16/image32/modernImage reference to a data: URI, or null if
   *  unresolvable. `isModern` additionally tries matching `ref` against Dataverse's built-in Fluent
   *  icon set when the web resource lookup finds nothing -- see fluentIcon.ts. */
  getIcon: { params: { ref: string; isModern?: boolean }; result: string | null };
  /** Web resource names matching `query` (contains, case-insensitive per Dataverse's OData contains()), capped at 25, for the icon/library fields' search-as-you-type. */
  searchWebResources: { params: { query: string }; result: string[] };
}
export type RpcOp = keyof RpcRequestMap;

export interface RpcRequest {
  kind: 'request';
  id: number;
  op: RpcOp;
  params: unknown;
}
export type RpcResponse =
  | { kind: 'response'; id: number; ok: true; data: unknown }
  | { kind: 'response'; id: number; ok: false; error: string };
