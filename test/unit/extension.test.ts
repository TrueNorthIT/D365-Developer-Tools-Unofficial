import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscodeMock from '../mocks/vscode';
import { activate, deactivate } from '../../src/extension';
import * as webResourceManagerModule from '../../src/webResourceManager';
import * as dataverseClientModule from '../../src/dataverseClient';

function makeContext(extensionPath: string) {
    const workspaceStateStore = new Map<string, unknown>();
    const globalStateStore = new Map<string, unknown>();
    const secretsStore = new Map<string, string>();

    return {
        subscriptions: [] as Array<{ dispose(): void }>,
        extensionPath,
        workspaceState: {
            get: <T>(key: string, def?: T) => (workspaceStateStore.has(key) ? workspaceStateStore.get(key) : def) as T,
            update: async (key: string, value: unknown) => {
                if (value === undefined) { workspaceStateStore.delete(key); } else { workspaceStateStore.set(key, value); }
            },
        },
        globalState: {
            get: <T>(key: string, def?: T) => (globalStateStore.has(key) ? globalStateStore.get(key) : def) as T,
            update: async (key: string, value: unknown) => { globalStateStore.set(key, value); },
        },
        secrets: {
            get: async (key: string) => secretsStore.get(key),
            store: async (key: string, value: string) => { secretsStore.set(key, value); },
        },
    } as unknown as import('vscode').ExtensionContext;
}

function captureCommands() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    sinon.stub(vscodeMock.commands, 'registerCommand').callsFake((id: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(id, handler);
        return new vscodeMock.Disposable();
    });
    return handlers;
}

describe('extension.activate', () => {
    afterEach(() => {
        sinon.restore();
        vscodeMock.resetVscodeMock();
    });

    it('registers all commands, providers, and the webview without throwing', async () => {
        const handlers = captureCommands();
        const codeActionSpy = sinon.spy(vscodeMock.languages, 'registerCodeActionsProvider');
        const completionSpy = sinon.spy(vscodeMock.languages, 'registerCompletionItemProvider');
        const webviewSpy = sinon.spy(vscodeMock.window, 'registerWebviewViewProvider');

        const ctx = makeContext('/fake/extension/path');
        assert.doesNotThrow(() => activate(ctx));
        // tryRestoreConnection() is fired without awaiting; let its microtasks settle.
        await Promise.resolve();
        await Promise.resolve();

        const expectedCommands = [
            'd365.connect', 'd365.disconnect', 'd365.switchAccount', 'd365.statusBarMenu',
            'd365.refreshEntities', 'd365.browseEntity', 'd365.generateInterface',
            'd365.publishWebResource', 'd365.publishWebResources', 'd365.configureWebResources',
            'd365.compareWebResource', 'd365.configureMcp', 'd365.codeAction.insertInterface',
            'd365.previewForm', 'd365.previewView', 'd365.previewFormInNewWindow', 'd365.previewViewInNewWindow',
        ];
        for (const cmd of expectedCommands) {
            assert.ok(handlers.has(cmd), `expected command '${cmd}' to be registered`);
        }

        assert.ok(codeActionSpy.calledOnce);
        assert.ok(completionSpy.calledOnce);
        assert.ok(webviewSpy.calledOnce);
        assert.ok(ctx.subscriptions.length > 0);

        assert.doesNotThrow(() => deactivate());
    });

    describe('d365.publishWebResource target selection', () => {
        async function getHandler() {
            const handlers = captureCommands();
            const ctx = makeContext('/fake/extension/path');
            activate(ctx);
            await Promise.resolve();
            return handlers.get('d365.publishWebResource')!;
        }

        it('shows a warning when no uri, uris, or active editor is available', async () => {
            const handler = await getHandler();
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);
            const publishStub = sinon.stub(webResourceManagerModule, 'publishWebResources').resolves();

            await handler(undefined, undefined);

            assert.ok(warnStub.calledWithMatch(/No file selected/));
            assert.ok(!publishStub.called);
        });

        it('uses the explicit uris array when provided, ignoring the single uri/active editor', async () => {
            const handler = await getHandler();
            const publishStub = sinon.stub(webResourceManagerModule, 'publishWebResources').resolves();
            const uris = [vscodeMock.Uri.file('/ws/webresources/a.js'), vscodeMock.Uri.file('/ws/webresources/b.js')];

            await handler(vscodeMock.Uri.file('/ws/webresources/ignored.js'), uris);

            assert.ok(publishStub.calledOnce);
            assert.deepStrictEqual(publishStub.firstCall.args[0], uris);
        });

        it('falls back to the single uri when no uris array is given', async () => {
            const handler = await getHandler();
            const publishStub = sinon.stub(webResourceManagerModule, 'publishWebResources').resolves();
            const uri = vscodeMock.Uri.file('/ws/webresources/a.js');

            await handler(uri, undefined);

            assert.deepStrictEqual(publishStub.firstCall.args[0], [uri]);
        });

        it('falls back to the active editor document when neither uri nor uris is given', async () => {
            const handler = await getHandler();
            const publishStub = sinon.stub(webResourceManagerModule, 'publishWebResources').resolves();
            const activeUri = vscodeMock.Uri.file('/ws/webresources/active.js');
            vscodeMock.window.activeTextEditor = { document: { uri: activeUri } };

            await handler(undefined, undefined);

            assert.deepStrictEqual(publishStub.firstCall.args[0], [activeUri]);
        });
    });

    describe('d365.configureMcp', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-mcp-test-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        async function getHandler(extensionPath: string) {
            const handlers = captureCommands();
            const ctx = makeContext(extensionPath);
            activate(ctx);
            await Promise.resolve();
            return handlers.get('d365.configureMcp')!;
        }

        it('shows an error when no workspace folder is open', async () => {
            vscodeMock.workspace.workspaceFolders = undefined;
            const handler = await getHandler(tmpDir);
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            await handler();

            assert.ok(errorStub.calledWithMatch(/Open a workspace folder/));
        });

        it('shows an error when the mcp-server bundle is missing from the extension install', async () => {
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir); // tmpDir has no out/mcp-server.js
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            await handler();

            assert.ok(errorStub.calledWithMatch(/MCP server bundle not found/));
            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('writes a fresh .mcp.json with the d365 server entry on the happy path', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            await handler();

            const written = JSON.parse(fs.readFileSync(path.join(wsRoot, '.mcp.json'), 'utf8'));
            assert.strictEqual(written.mcpServers.d365.command, 'node');
            assert.strictEqual(written.mcpServers.d365.args[0], path.join(tmpDir, 'out', 'mcp-server.js'));
            assert.ok(infoStub.calledWithMatch(/Configured \.mcp\.json/));

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('shows an info message and does not overwrite an existing d365 mcp entry', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            const existing = { mcpServers: { d365: { command: 'node', args: ['/already/configured.js'] } } };
            fs.writeFileSync(path.join(wsRoot, '.mcp.json'), JSON.stringify(existing));
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            await handler();

            assert.ok(infoStub.calledWithMatch(/already configured/));
            const stillThere = JSON.parse(fs.readFileSync(path.join(wsRoot, '.mcp.json'), 'utf8'));
            assert.strictEqual(stillThere.mcpServers.d365.args[0], '/already/configured.js');

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('shows an error when .mcp.json exists but is not valid JSON', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            fs.writeFileSync(path.join(wsRoot, '.mcp.json'), '{ not valid json');
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            await handler();

            assert.ok(errorStub.calledWithMatch(/not valid JSON/));

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('appends .mcp.json to an existing .gitignore that does not already ignore it', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            fs.writeFileSync(path.join(wsRoot, '.gitignore'), 'node_modules/\nout/\n');
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            await handler();

            const gitignore = fs.readFileSync(path.join(wsRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.split(/\r?\n/).includes('.mcp.json'));

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('does not duplicate the .gitignore entry if .mcp.json is already ignored', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            fs.writeFileSync(path.join(wsRoot, '.gitignore'), 'node_modules/\n.mcp.json\n');
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            await handler();

            const gitignore = fs.readFileSync(path.join(wsRoot, '.gitignore'), 'utf8');
            const occurrences = gitignore.split(/\r?\n/).filter((line) => line === '.mcp.json').length;
            assert.strictEqual(occurrences, 1);

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('prompts to create a .gitignore when none exists, and does not create one if declined', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves('No' as any);

            await handler();

            assert.ok(infoStub.calledWithMatch(/No \.gitignore found/, { modal: true }, 'Yes', 'No'));
            assert.ok(!fs.existsSync(path.join(wsRoot, '.gitignore')));

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });

        it('creates a .gitignore with the entry when the user accepts the prompt', async () => {
            fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'out', 'mcp-server.js'), '// stub');
            const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-ws-'));
            vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 }];
            const handler = await getHandler(tmpDir);
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves('Yes' as any);

            await handler();

            const gitignore = fs.readFileSync(path.join(wsRoot, '.gitignore'), 'utf8');
            assert.strictEqual(gitignore, '.mcp.json\n');

            fs.rmSync(wsRoot, { recursive: true, force: true });
        });
    });

    describe('d365.generateInterface / d365.browseEntity', () => {
        async function getHandlers() {
            const handlers = captureCommands();
            const ctx = makeContext('/fake/extension/path');
            activate(ctx);
            await Promise.resolve();
            return handlers;
        }

        it('generateInterface shows an error and does not prompt when getEntities() fails', async () => {
            const handlers = await getHandlers();
            sinon.stub(dataverseClientModule.DataverseClient.prototype, 'getEntities').rejects(new Error('network down'));
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const quickPickStub = sinon.stub(vscodeMock.window, 'showQuickPick');

            await handlers.get('d365.generateInterface')!();

            assert.ok(errorStub.calledWithMatch(/Failed to load entities/));
            assert.ok(!quickPickStub.called);
        });

        it('browseEntity does nothing further when the entity quick pick is cancelled', async () => {
            const handlers = await getHandlers();
            sinon.stub(dataverseClientModule.DataverseClient.prototype, 'getEntities').resolves([
                { metadataId: 'm1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false },
            ]);
            const quickPickStub = sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);
            const attrsStub = sinon.stub(dataverseClientModule.DataverseClient.prototype, 'getAttributes');

            await handlers.get('d365.browseEntity')!();

            assert.ok(quickPickStub.calledOnce);
            assert.ok(!attrsStub.called);
        });
    });
});
