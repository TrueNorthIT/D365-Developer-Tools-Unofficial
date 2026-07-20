import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { ConnectionManager } from './connectionManager';

export interface BridgeState {
    port: number;
    nonce: string;
}

// Whether "D365: Configure MCP Server for this Workspace" has been run for this workspace folder --
// i.e. .mcp.json exists and declares a "d365" server. Shared by the configure command (extension.ts)
// and the MCP status bar item, which only shows itself once this is true.
export function isMcpConfigured(workspaceRoot: string): boolean {
    const mcpJsonPath = path.join(workspaceRoot, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) { return false; }

    try {
        const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>;
        const servers = parsed['mcpServers'] as Record<string, unknown> | undefined;
        return !!servers?.['d365'];
    } catch {
        return false;
    }
}

export class McpBridge {
    private server: http.Server | undefined;
    // Home-directory location so the MCP server can always find it
    // regardless of which workspace is currently open in VS Code.
    readonly bridgeFile = path.join(os.homedir(), '.d365-mcp-bridge');

    private readonly _onDidChangeState = new vscode.EventEmitter<boolean>();
    /** Fires with the new running state whenever start()/stop() actually change it. */
    readonly onDidChangeState = this._onDidChangeState.event;

    get isRunning(): boolean { return !!this.server; }

    constructor(private readonly connectionManager: ConnectionManager) {}

    start(): void {
        if (this.server) { return; }

        const nonce = crypto.randomBytes(32).toString('hex');

        this.server = http.createServer(async (req, res) => {
            if (req.method !== 'GET' || req.url !== '/token') {
                res.writeHead(404);
                res.end();
                return;
            }
            if (req.headers['authorization'] !== `Bearer ${nonce}`) {
                res.writeHead(401);
                res.end();
                return;
            }
            try {
                const token = await this.connectionManager.getAccessToken();
                const environmentUrl = this.connectionManager.connection?.environmentUrl;
                if (!environmentUrl) { throw new Error('No active Dataverse connection.'); }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token, environmentUrl }));
            } catch (err) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(err) }));
            }
        });

        this.server.listen(0, '127.0.0.1', () => {
            const addr = this.server!.address();
            if (!addr || typeof addr === 'string') { return; }
            const state: BridgeState = { port: addr.port, nonce };
            fs.writeFileSync(this.bridgeFile, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
        });
        this._onDidChangeState.fire(true);
    }

    stop(): void {
        if (!this.server) { return; }
        this.server.close();
        this.server = undefined;
        try { fs.unlinkSync(this.bridgeFile); } catch { /* already gone */ }
        this._onDidChangeState.fire(false);
    }

    dispose(): void { this.stop(); }
}
