import type { OutboundMessage } from './protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi() may only be called once per webview — this module is the single owner of the handle.
const vscode = acquireVsCodeApi();

export function post(message: OutboundMessage): void {
  vscode.postMessage(message);
}

/** Post an arbitrary payload (used by the RPC layer for request envelopes). */
export function postRaw(message: unknown): void {
  vscode.postMessage(message);
}
