// Message protocol between the extension host (entityExplorerWebview.ts) and this webview.
// Kept webview-local (a subset of the extension's domain types) so the webview tsconfig
// doesn't have to resolve the extension's Node/`vscode` imports.
//
// Two channels share the postMessage transport:
//   1. Events (fire-and-forget, often extension-initiated push): InboundMessage / OutboundMessage.
//   2. Request/response RPC (webview-initiated pull): RpcRequest / RpcResponse — see rpc.ts.
//      Pull-shaped, cacheable data (attributes, icons, future relationships) goes over RPC and
//      is managed by TanStack Query; genuinely event-shaped state stays on the reducer.

export interface EntityInfo {
  metadataId: string;
  logicalName: string;
  displayName: string;
  /** Logical name of the SVG web resource used as this table's icon, if any. */
  iconVectorName?: string;
  /** Numeric entity type code — resolves the built-in /_imgs/svg_<otc>.svg icon. */
  objectTypeCode?: number;
}

export interface AttributeInfo {
  logicalName: string;
  displayName: string;
  attributeType: string;
  isPrimaryId: boolean;
  isPrimaryName: boolean;
}

// ── Events: Extension → Webview ───────────────────────────────────────────────
export type InboundMessage =
  | { type: 'connectionState'; connected: boolean; restoring: boolean }
  | { type: 'entitiesLoading' }
  | { type: 'entities'; data: EntityInfo[] }
  | { type: 'entitiesError'; message: string }
  // A cached entity list is already showing (see 'entities') and a background refetch has started.
  | { type: 'entitiesRefreshing' }
  // The background refetch completed -- unlike 'entities', this must NOT reset expand/collapse state,
  // since the user may already be interacting with the tree the cached 'entities' message rendered.
  | { type: 'entitiesRefreshed'; data: EntityInfo[] }
  | { type: 'solutionFilter'; name: string; entityIds: string[] };

// ── Events: Webview → Extension ───────────────────────────────────────────────
export type OutboundMessage =
  | { type: 'ready' }
  | { type: 'connect' }
  | { type: 'showSolutionPicker' }
  | { type: 'clearSolutionFilter' }
  | { type: 'makeInterface'; entityLogicalName: string; entityDisplayName: string }
  | {
      type: 'makeEnum';
      entityLogicalName: string;
      attributeLogicalName: string;
      attributeDisplayName: string;
      attributeType: string;
    };

// ── RPC: request/response over the same transport ─────────────────────────────
// Adding a new data source (e.g. relationships) = one new op here + one handler case in
// the extension + one useQuery in the webview. No transport changes.
export interface RpcRequestMap {
  getAttributes: { params: { entityLogicalName: string }; result: AttributeInfo[] };
  /** Returns base64 SVG content, or null when the table has no resolvable icon. */
  getIcon: { params: { key: string }; result: string | null };
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
