import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscodeMock from '../mocks/vscode';
import { McpStatusBar } from '../../src/mcpStatusBar';
import type { McpBridge } from '../../src/mcpBridge';

function makeFakeBridge(initialRunning = false) {
    const emitter = new vscodeMock.EventEmitter<boolean>();
    let running = initialRunning;
    const bridge = {
        onDidChangeState: emitter.event,
        get isRunning() { return running; },
    };
    return {
        bridge: bridge as unknown as McpBridge,
        fire: (state: boolean) => { running = state; emitter.fire(state); },
    };
}

describe('McpStatusBar', () => {
    let tmpDir: string;
    let workspaceFolder: { uri: vscodeMock.Uri; name: string; index: number };
    let item: { text: string; tooltip: unknown; show: sinon.SinonStub; hide: sinon.SinonStub; dispose: sinon.SinonStub };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-statusbar-test-'));
        workspaceFolder = { uri: vscodeMock.Uri.file(tmpDir), name: 'ws', index: 0 };
        vscodeMock.workspace.workspaceFolders = [workspaceFolder];
        item = { text: '', tooltip: undefined, show: sinon.stub(), hide: sinon.stub(), dispose: sinon.stub() };
        sinon.stub(vscodeMock.window, 'createStatusBarItem').returns(item as any);
    });

    afterEach(() => {
        sinon.restore();
        vscodeMock.resetVscodeMock();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeMcpJson(configured: boolean): void {
        const content = configured ? { mcpServers: { d365: { command: 'node', args: [] } } } : { mcpServers: {} };
        fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(content));
    }

    it('stays hidden when no workspace folder is open', () => {
        vscodeMock.workspace.workspaceFolders = undefined;
        const { bridge } = makeFakeBridge();

        new McpStatusBar(bridge);

        assert.ok(item.hide.called);
        assert.ok(!item.show.called);
    });

    it('stays hidden when .mcp.json does not declare a d365 server', () => {
        const { bridge } = makeFakeBridge();

        new McpStatusBar(bridge);

        assert.ok(item.hide.called);
        assert.ok(!item.show.called);
    });

    it('shows "MCP Inactive" when configured but the bridge is not running', () => {
        writeMcpJson(true);
        const { bridge } = makeFakeBridge(false);

        new McpStatusBar(bridge);

        assert.ok(item.show.called);
        assert.match(item.text, /MCP Inactive/);
    });

    it('shows "MCP Active" when configured and the bridge is running', () => {
        writeMcpJson(true);
        const { bridge } = makeFakeBridge(true);

        new McpStatusBar(bridge);

        assert.ok(item.show.called);
        assert.match(item.text, /MCP Active/);
    });

    it('updates text when the bridge fires onDidChangeState', () => {
        writeMcpJson(true);
        const { bridge, fire } = makeFakeBridge(false);
        new McpStatusBar(bridge);
        assert.match(item.text, /MCP Inactive/);

        fire(true);
        assert.match(item.text, /MCP Active/);

        fire(false);
        assert.match(item.text, /MCP Inactive/);
    });

    it('updates (and shows) once .mcp.json is created after construction', () => {
        const { bridge } = makeFakeBridge(true);
        const watcher = new vscodeMock.FileSystemWatcherMock();
        sinon.stub(vscodeMock.workspace, 'createFileSystemWatcher').returns(watcher as any);

        new McpStatusBar(bridge);
        assert.ok(!item.show.called, 'not configured yet');

        writeMcpJson(true);
        watcher.triggerCreate();

        assert.ok(item.show.called);
        assert.match(item.text, /MCP Active/);
    });

    it('dispose() disposes the status bar item without throwing', () => {
        writeMcpJson(true);
        const { bridge } = makeFakeBridge(true);
        const statusBar = new McpStatusBar(bridge);

        assert.doesNotThrow(() => statusBar.dispose());
        assert.ok(item.dispose.called);
    });
});
