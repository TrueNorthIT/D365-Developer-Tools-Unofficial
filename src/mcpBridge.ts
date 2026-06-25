import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ConnectionManager } from './connectionManager';

export interface BridgeState {
    port: number;
    nonce: string;
}

export class McpBridge {
    private server: http.Server | undefined;
    readonly bridgeFile: string;

    constructor(
        private readonly connectionManager: ConnectionManager,
        workspaceRoot: string,
    ) {
        this.bridgeFile = path.join(workspaceRoot, '.d365-mcp-bridge');
    }

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
                const token          = await this.connectionManager.getAccessToken();
                const environmentUrl = this.connectionManager.connection?.environmentUrl;
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
            fs.writeFileSync(this.bridgeFile, JSON.stringify(state), 'utf8');
        });
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
        try { fs.unlinkSync(this.bridgeFile); } catch { /* already gone */ }
    }

    dispose(): void { this.stop(); }
}
