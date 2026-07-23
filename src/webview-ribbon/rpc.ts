import type { RpcOp, RpcRequestMap, RpcResponse } from './protocol';
import { postRaw } from './vscodeApi';

// Promise-based request/response layer over the webview postMessage transport — identical shape to
// src/webview/rpc.ts (the sidebar's), typed against this panel's own RpcRequestMap.

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener('message', (e: MessageEvent<RpcResponse>) => {
  const m = e.data;
  if (!m || m.kind !== 'response') { return; }
  const entry = pending.get(m.id);
  if (!entry) { return; }
  pending.delete(m.id);
  if (m.ok) { entry.resolve(m.data); }
  else { entry.reject(new Error(m.error)); }
});

export function request<Op extends RpcOp>(
  op: Op,
  params: RpcRequestMap[Op]['params'],
): Promise<RpcRequestMap[Op]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    postRaw({ kind: 'request', id, op, params });
  });
}
