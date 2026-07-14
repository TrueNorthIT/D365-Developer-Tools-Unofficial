import * as vscode from 'vscode';

// A single shared "D365 Developer Tools" output channel. Lazily created so importing this module
// has no side effects until something actually logs; extension.ts eagerly grabs it once at
// activation so it shows up in the Output panel dropdown right away.

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!channel) { channel = vscode.window.createOutputChannel('D365 Developer Tools'); }
    return channel;
}

export function log(message: string): void {
    getOutputChannel().appendLine(`[${timestamp()}] ${message}`);
}

// Logs the error (with its stack trace, when available) and reveals the output channel — meant
// for failures the user needs to debug, not routine/expected-path noise.
export function logError(context: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack || err.message) : String(err);
    const out = getOutputChannel();
    out.appendLine(`[${timestamp()}] ERROR ${context}: ${detail}`);
    out.show(true);
}

function timestamp(): string {
    return new Date().toISOString();
}
