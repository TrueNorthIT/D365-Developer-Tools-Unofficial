import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { isMcpConfigured } from '../../src/mcpBridge';
import type { ConnectionManager } from '../../src/connectionManager';

describe('McpBridge', () => {
    let tmpDir: string;
    let homedirStub: sinon.SinonStub;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let McpBridgeCtor: typeof import('../../src/mcpBridge').McpBridge;

    function fakeConnectionManager(overrides: Partial<{
        getAccessToken: () => Promise<string>;
        connection: { environmentUrl: string } | undefined;
    }> = {}) {
        return {
            getAccessToken: overrides.getAccessToken ?? (async () => 'tok123'),
            connection: 'connection' in overrides ? overrides.connection : { environmentUrl: 'https://contoso.crm.dynamics.com' },
        } as unknown as ConnectionManager;
    }

    async function waitForFile(filePath: string, timeoutMs = 2000): Promise<void> {
        const start = Date.now();
        while (!fs.existsSync(filePath)) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timed out waiting for file: ${filePath}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    before(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-test-'));
        // Stub os.homedir BEFORE requiring the module under test, so the class field
        // initializer (`readonly bridgeFile = path.join(os.homedir(), ...)`) captures
        // the stubbed value rather than the real home directory.
        homedirStub = sinon.stub(require('os'), 'homedir').returns(tmpDir);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        McpBridgeCtor = require('../../src/mcpBridge').McpBridge;
    });

    after(() => {
        homedirStub.restore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    let bridge: InstanceType<typeof McpBridgeCtor>;

    afterEach(() => {
        if (bridge) {
            bridge.stop();
        }
    });

    it('computes bridgeFile under the stubbed home directory', () => {
        bridge = new McpBridgeCtor(fakeConnectionManager());
        assert.ok(
            bridge.bridgeFile.startsWith(tmpDir),
            `expected bridgeFile (${bridge.bridgeFile}) to start with tmpDir (${tmpDir})`,
        );
        assert.strictEqual(path.basename(bridge.bridgeFile), '.d365-mcp-bridge');
    });

    it('start() listens on 127.0.0.1 on an OS-assigned port and writes the bridge file', async () => {
        bridge = new McpBridgeCtor(fakeConnectionManager());
        bridge.start();
        await waitForFile(bridge.bridgeFile);

        const raw = fs.readFileSync(bridge.bridgeFile, 'utf8');
        const state = JSON.parse(raw);
        assert.strictEqual(typeof state.port, 'number');
        assert.ok(state.port > 0);
        assert.strictEqual(typeof state.nonce, 'string');
        assert.strictEqual(state.nonce.length, 64); // 32 bytes hex-encoded

        const server: import('http').Server | undefined = (bridge as any).server;
        assert.ok(server, 'expected server to be set');
        const addr = server!.address();
        assert.ok(addr && typeof addr !== 'string');
        assert.strictEqual((addr as import('net').AddressInfo).address, '127.0.0.1');

        if (process.platform !== 'win32') {
            const mode = fs.statSync(bridge.bridgeFile).mode & 0o777;
            assert.strictEqual(mode, 0o600);
        }
    });

    it('start() called twice is a no-op the second time', async () => {
        bridge = new McpBridgeCtor(fakeConnectionManager());
        bridge.start();
        await waitForFile(bridge.bridgeFile);

        const serverBefore = (bridge as any).server;
        const stateBefore = JSON.parse(fs.readFileSync(bridge.bridgeFile, 'utf8'));

        bridge.start(); // should be a no-op

        const serverAfter = (bridge as any).server;
        assert.strictEqual(serverBefore, serverAfter, 'server reference should be unchanged');

        // Give any (unexpected) async re-write a moment to occur, then verify nonce unchanged.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const stateAfter = JSON.parse(fs.readFileSync(bridge.bridgeFile, 'utf8'));
        assert.strictEqual(stateAfter.nonce, stateBefore.nonce);
        assert.strictEqual(stateAfter.port, stateBefore.port);
    });

    describe('HTTP /token endpoint', () => {
        async function startAndGetState(cm: ConnectionManager) {
            bridge = new McpBridgeCtor(cm);
            bridge.start();
            await waitForFile(bridge.bridgeFile);
            const state = JSON.parse(fs.readFileSync(bridge.bridgeFile, 'utf8')) as { port: number; nonce: string };
            return state;
        }

        it('returns 200 with token and environmentUrl for a valid request', async () => {
            const state = await startAndGetState(fakeConnectionManager());
            const res = await fetch(`http://127.0.0.1:${state.port}/token`, {
                headers: { Authorization: `Bearer ${state.nonce}` },
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.deepStrictEqual(body, {
                token: 'tok123',
                environmentUrl: 'https://contoso.crm.dynamics.com',
            });
        });

        it('returns 401 for a missing Authorization header', async () => {
            const state = await startAndGetState(fakeConnectionManager());
            const res = await fetch(`http://127.0.0.1:${state.port}/token`);
            assert.strictEqual(res.status, 401);
        });

        it('returns 401 for a wrong Authorization header', async () => {
            const state = await startAndGetState(fakeConnectionManager());
            const res = await fetch(`http://127.0.0.1:${state.port}/token`, {
                headers: { Authorization: 'Bearer wrong-nonce' },
            });
            assert.strictEqual(res.status, 401);
        });

        it('returns 404 for an unknown path', async () => {
            const state = await startAndGetState(fakeConnectionManager());
            const res = await fetch(`http://127.0.0.1:${state.port}/other`, {
                headers: { Authorization: `Bearer ${state.nonce}` },
            });
            assert.strictEqual(res.status, 404);
        });

        it('returns 404 for a wrong method (POST) to /token', async () => {
            const state = await startAndGetState(fakeConnectionManager());
            const res = await fetch(`http://127.0.0.1:${state.port}/token`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${state.nonce}` },
            });
            assert.strictEqual(res.status, 404);
        });

        it('returns 503 with an error body when getAccessToken rejects', async () => {
            const state = await startAndGetState(
                fakeConnectionManager({ getAccessToken: async () => { throw new Error('boom'); } }),
            );
            const res = await fetch(`http://127.0.0.1:${state.port}/token`, {
                headers: { Authorization: `Bearer ${state.nonce}` },
            });
            assert.strictEqual(res.status, 503);
            const body = await res.json() as { error: string };
            assert.ok(typeof body.error === 'string' && body.error.length > 0);
        });

        it('returns 503 with an error body when connection is undefined', async () => {
            const state = await startAndGetState(fakeConnectionManager({ connection: undefined }));
            const res = await fetch(`http://127.0.0.1:${state.port}/token`, {
                headers: { Authorization: `Bearer ${state.nonce}` },
            });
            assert.strictEqual(res.status, 503);
            const body = await res.json() as { error: string };
            assert.ok(typeof body.error === 'string' && body.error.length > 0);
        });
    });

    describe('stop() and dispose()', () => {
        it('stop() closes the server and removes the bridge file', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            bridge.start();
            await waitForFile(bridge.bridgeFile);

            bridge.stop();

            assert.strictEqual((bridge as any).server, undefined);
            assert.strictEqual(fs.existsSync(bridge.bridgeFile), false);
        });

        it('stop() does not throw when nothing was started', () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            assert.doesNotThrow(() => bridge.stop());
        });

        it('stop() does not throw when the bridge file was already removed', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            bridge.start();
            await waitForFile(bridge.bridgeFile);
            fs.unlinkSync(bridge.bridgeFile);
            assert.doesNotThrow(() => bridge.stop());
        });

        it('dispose() calls stop() and removes the bridge file', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            bridge.start();
            await waitForFile(bridge.bridgeFile);

            bridge.dispose();

            assert.strictEqual((bridge as any).server, undefined);
            assert.strictEqual(fs.existsSync(bridge.bridgeFile), false);
        });
    });

    describe('isRunning / onDidChangeState', () => {
        it('isRunning is false before start() and true once started', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            assert.strictEqual(bridge.isRunning, false);

            bridge.start();
            assert.strictEqual(bridge.isRunning, true);
            await waitForFile(bridge.bridgeFile);
        });

        it('isRunning is false again after stop()', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            bridge.start();
            await waitForFile(bridge.bridgeFile);

            bridge.stop();

            assert.strictEqual(bridge.isRunning, false);
        });

        it('fires onDidChangeState(true) on start() and onDidChangeState(false) on stop()', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            const states: boolean[] = [];
            bridge.onDidChangeState(s => states.push(s));

            bridge.start();
            await waitForFile(bridge.bridgeFile);
            bridge.stop();

            assert.deepStrictEqual(states, [true, false]);
        });

        it('does not re-fire onDidChangeState for a redundant start() or stop()', async () => {
            bridge = new McpBridgeCtor(fakeConnectionManager());
            const states: boolean[] = [];
            bridge.onDidChangeState(s => states.push(s));

            bridge.start();
            await waitForFile(bridge.bridgeFile);
            bridge.start(); // no-op, already running
            bridge.stop();
            bridge.stop(); // no-op, already stopped

            assert.deepStrictEqual(states, [true, false]);
        });
    });
});

describe('isMcpConfigured', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-configured-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false when .mcp.json does not exist', () => {
        assert.strictEqual(isMcpConfigured(tmpDir), false);
    });

    it('returns false when .mcp.json exists but has no d365 server entry', () => {
        fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }));
        assert.strictEqual(isMcpConfigured(tmpDir), false);
    });

    it('returns true when .mcp.json declares a d365 server', () => {
        fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { d365: { command: 'node', args: [] } } }));
        assert.strictEqual(isMcpConfigured(tmpDir), true);
    });

    it('returns false when .mcp.json is not valid JSON', () => {
        fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{ not valid json');
        assert.strictEqual(isMcpConfigured(tmpDir), false);
    });
});
