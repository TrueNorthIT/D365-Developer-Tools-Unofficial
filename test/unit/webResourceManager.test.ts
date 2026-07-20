import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscodeMock from '../mocks/vscode';
import {
    compareWebResource,
    publishWebResources,
    publishWebResourcesCommand,
    configureWebResourcesCommand,
    WebResourceContentProvider,
    DIFF_SCHEME,
} from '../../src/webResourceManager';
import type { ConnectionManager } from '../../src/connectionManager';
import type { DataverseClient, Solution } from '../../src/dataverseClient';

const CONFIG_SECTION = 'd365.webResources';

describe('webResourceManager', () => {
    afterEach(() => {
        sinon.restore();
        vscodeMock.resetVscodeMock();
    });

    // ── WebResourceContentProvider ──────────────────────────────────────────

    describe('WebResourceContentProvider', () => {
        it('returns content set via setContent, and consumes it on read (second read is empty)', () => {
            const provider = new WebResourceContentProvider();
            const uri = vscodeMock.Uri.parse(`${DIFF_SCHEME}:/foo.js?1`);
            provider.setContent(uri, 'hello world');

            assert.strictEqual(provider.provideTextDocumentContent(uri), 'hello world');
            assert.strictEqual(provider.provideTextDocumentContent(uri), '');
        });

        it('returns empty string for a uri that was never set', () => {
            const provider = new WebResourceContentProvider();
            const uri = vscodeMock.Uri.parse(`${DIFF_SCHEME}:/never-set.js?1`);
            assert.strictEqual(provider.provideTextDocumentContent(uri), '');
        });
    });

    // ── compareWebResource ───────────────────────────────────────────────────

    describe('compareWebResource', () => {
        const WORKSPACE_ROOT = path.resolve('/workspace');
        let contentProvider: WebResourceContentProvider;
        let client: { getWebResourceIdByName: sinon.SinonStub; getWebResourceContent: sinon.SinonStub };

        beforeEach(() => {
            vscodeMock.workspace.workspaceFolders = [
                { uri: vscodeMock.Uri.file(WORKSPACE_ROOT), name: 'ws', index: 0 },
            ];
            vscodeMock.__setConfig(CONFIG_SECTION, { rootFolder: 'webresources', namePrefix: '' });
            contentProvider = new WebResourceContentProvider();
            client = {
                getWebResourceIdByName: sinon.stub(),
                getWebResourceContent: sinon.stub(),
            };
        });

        function connMgr(isConnected: boolean): ConnectionManager {
            return { isConnected } as unknown as ConnectionManager;
        }

        it('shows a warning and does nothing when no file is selected and there is no active editor', async () => {
            vscodeMock.window.activeTextEditor = undefined;
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);

            await compareWebResource(undefined, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(warnStub.calledOnce);
            assert.match(warnStub.firstCall.args[0], /No file selected/);
            assert.ok(client.getWebResourceIdByName.notCalled);
        });

        it('shows an error and does not call the client when not connected', async () => {
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'webresources', 'main.js'));

            await compareWebResource(fileUri, connMgr(false), client as unknown as DataverseClient, contentProvider);

            assert.ok(errStub.calledOnce);
            assert.match(errStub.firstCall.args[0], /Connect to an environment/);
            assert.ok(client.getWebResourceIdByName.notCalled);
        });

        it('errors when the file is not under the configured web resources root folder', async () => {
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'src', 'other.js'));

            await compareWebResource(fileUri, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(errStub.calledOnce);
            assert.match(errStub.firstCall.args[0], /not under the configured web resources root folder/);
        });

        it('errors when the file extension is not text-diffable', async () => {
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'webresources', 'logo.png'));

            await compareWebResource(fileUri, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(errStub.calledOnce);
            assert.match(errStub.firstCall.args[0], /\.png/);
            assert.match(errStub.firstCall.args[0], /isn't supported/);
        });

        it('warns when the web resource does not exist on the server yet', async () => {
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);
            client.getWebResourceIdByName.resolves(undefined);
            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'webresources', 'main.js'));

            await compareWebResource(fileUri, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(warnStub.calledOnce);
            assert.match(warnStub.firstCall.args[0], /does not exist on the server yet/);
            assert.ok(client.getWebResourceContent.notCalled);
        });

        it('happy path: loads server content, caches it, and opens a diff', async () => {
            client.getWebResourceIdByName.resolves('id-1');
            const decodedContent = 'console.log(1);';
            client.getWebResourceContent.resolves(Buffer.from(decodedContent, 'utf8').toString('base64'));
            const executeCommandStub = sinon.stub(vscodeMock.commands, 'executeCommand').resolves(undefined);

            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'webresources', 'scripts', 'main.js'));
            await compareWebResource(fileUri, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(executeCommandStub.calledOnce);
            const call = executeCommandStub.firstCall;
            assert.strictEqual(call.args[0], 'vscode.diff');
            assert.strictEqual(call.args[1], fileUri);
            const serverUri = call.args[2] as vscodeMock.Uri;
            assert.ok(serverUri.toString().startsWith(`${DIFF_SCHEME}:/`));
            assert.match(call.args[3] as string, /scripts\/main\.js/);

            assert.strictEqual(contentProvider.provideTextDocumentContent(serverUri), decodedContent);
            // consumed on read
            assert.strictEqual(contentProvider.provideTextDocumentContent(serverUri), '');
        });

        it('shows an error mentioning the resource name when getWebResourceIdByName rejects', async () => {
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            client.getWebResourceIdByName.rejects(new Error('boom'));
            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'webresources', 'main.js'));

            await compareWebResource(fileUri, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(errStub.calledOnce);
            assert.match(errStub.firstCall.args[0], /main\.js/);
            assert.match(errStub.firstCall.args[0], /boom/);
        });

        it('shows an error mentioning the resource name when getWebResourceContent rejects', async () => {
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            client.getWebResourceIdByName.resolves('id-1');
            client.getWebResourceContent.rejects(new Error('server error'));
            const fileUri = vscodeMock.Uri.file(path.join(WORKSPACE_ROOT, 'webresources', 'main.js'));

            await compareWebResource(fileUri, connMgr(true), client as unknown as DataverseClient, contentProvider);

            assert.ok(errStub.calledOnce);
            assert.match(errStub.firstCall.args[0], /main\.js/);
            assert.match(errStub.firstCall.args[0], /server error/);
        });
    });

    // ── publishWebResources / publishWebResourcesCommand ────────────────────

    describe('publishWebResources / publishWebResourcesCommand', () => {
        let tmpDir: string;
        let webResourcesDir: string;
        let workspaceFolder: { uri: vscodeMock.Uri; name: string; index: number };
        let connected: { isConnected: boolean; getDefaultSolution: sinon.SinonStub };
        let client: {
            getWebResourceIdByName: sinon.SinonStub;
            updateWebResourceContent: sinon.SinonStub;
            createWebResource: sinon.SinonStub;
            addSolutionComponent: sinon.SinonStub;
            getSolutions: sinon.SinonStub;
            publishWebResources: sinon.SinonStub;
        };

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrm-test-'));
            webResourcesDir = path.join(tmpDir, 'webresources');
            fs.mkdirSync(webResourcesDir, { recursive: true });
            workspaceFolder = { uri: vscodeMock.Uri.file(tmpDir), name: 'ws', index: 0 };
            vscodeMock.workspace.workspaceFolders = [workspaceFolder];
            vscodeMock.__setConfig(CONFIG_SECTION, { rootFolder: 'webresources', namePrefix: '' });
            connected = { isConnected: true, getDefaultSolution: sinon.stub().returns(undefined) };
            client = {
                getWebResourceIdByName: sinon.stub(),
                updateWebResourceContent: sinon.stub().resolves(undefined),
                createWebResource: sinon.stub(),
                addSolutionComponent: sinon.stub().resolves(undefined),
                getSolutions: sinon.stub(),
                publishWebResources: sinon.stub().resolves(undefined),
            };
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        function writeFile(relPath: string, content = ''): vscodeMock.Uri {
            const full = path.join(webResourcesDir, relPath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
            return vscodeMock.Uri.file(full);
        }

        it('not connected -> error, no further calls', async () => {
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const fileUri = writeFile('a.js');

            await publishWebResources([fileUri], { isConnected: false } as unknown as ConnectionManager, client as unknown as DataverseClient);

            assert.ok(errStub.calledOnce);
            assert.ok(client.getWebResourceIdByName.notCalled);
        });

        it('filters out unsupported extensions and only processes supported ones', async () => {
            const jsUri = writeFile('a.js', 'x');
            const txtUri = vscodeMock.Uri.file(path.join(webResourcesDir, 'notes.txt'));
            client.getWebResourceIdByName.resolves('id-js');
            const withProgressSpy = sinon.spy(vscodeMock.window, 'withProgress');

            await publishWebResources(
                [jsUri, txtUri],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.strictEqual(client.getWebResourceIdByName.callCount, 1);
            assert.ok(client.getWebResourceIdByName.calledWith('a.js'));
            assert.ok(client.updateWebResourceContent.calledOnceWith('id-js', sinon.match.string));
            assert.ok(client.createWebResource.notCalled);
            assert.ok(withProgressSpy.calledOnce);
            assert.ok(client.publishWebResources.calledOnceWith(['id-js']));
        });

        it('warns when no supported files remain after filtering', async () => {
            const txtUri = vscodeMock.Uri.file(path.join(webResourcesDir, 'notes.txt'));
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);

            await publishWebResources(
                [txtUri],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.ok(warnStub.calledOnce);
            assert.match(warnStub.firstCall.args[0], /No supported web resource files found/);
            assert.ok(client.getWebResourceIdByName.notCalled);
        });

        it('expands a directory uri via findFiles', async () => {
            const dirUri = vscodeMock.Uri.file(path.join(webResourcesDir, 'sub'));
            const fileA = writeFile('sub/a.js', 'aaa');
            const fileB = writeFile('sub/b.css', 'bbb');
            sinon.stub(vscodeMock.workspace.fs, 'stat').callsFake(async (uri: unknown) => {
                const u = uri as vscodeMock.Uri;
                return u.fsPath === dirUri.fsPath
                    ? { type: vscodeMock.FileType.Directory }
                    : { type: vscodeMock.FileType.File };
            });
            const findFilesStub = sinon.stub(vscodeMock.workspace, 'findFiles').resolves([fileA, fileB]);
            client.getWebResourceIdByName.resolves('existing-id');

            await publishWebResources(
                [dirUri],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.ok(findFilesStub.calledOnce);
            assert.strictEqual(client.getWebResourceIdByName.callCount, 2);
            assert.ok(client.publishWebResources.calledOnce);
            const publishedIds = client.publishWebResources.firstCall.args[0] as string[];
            assert.strictEqual(publishedIds.length, 2);
        });

        it('creates a new web resource when the user confirms, and associates it with the chosen solution', async () => {
            const fileUri = writeFile('new.js', 'content');
            client.getWebResourceIdByName.resolves(undefined);
            sinon.stub(vscodeMock.window, 'showWarningMessage').resolves('Create');
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('New Script');
            const solutionObj: Solution = { solutionId: 's1', uniqueName: 'uniq1', friendlyName: 'Friendly 1' };
            client.getSolutions.resolves([solutionObj]);
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves({ type: 3 });
            // pickSolution uses createQuickPick (not showQuickPick) so it can pre-highlight a default.
            const quickPick = new vscodeMock.QuickPickMock<{ solution: Solution | null }>();
            sinon.stub(vscodeMock.window, 'createQuickPick').returns(quickPick as any);
            client.createWebResource.resolves('new-id-1');

            const publishPromise = publishWebResources(
                [fileUri],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );
            // Let the chain (real fs.readFile -> getWebResourceIdByName -> warning -> input -> type
            // pick -> getSolutions) run until pickSolution's QuickPick is shown and waiting on
            // selection -- fs.readFile resolves via real I/O, so this can take more than one tick.
            while (quickPick.items.length === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
            const solutionItem = quickPick.items.find(i => i.solution?.solutionId === 's1')!;
            quickPick.triggerAccept([solutionItem]);
            await publishPromise;

            assert.ok(client.createWebResource.calledOnce);
            const createArgs = client.createWebResource.firstCall.args[0];
            assert.strictEqual(createArgs.name, 'new.js');
            assert.strictEqual(createArgs.displayName, 'New Script');
            assert.strictEqual(createArgs.type, 3);
            assert.ok(client.addSolutionComponent.calledOnceWith('new-id-1', 'uniq1'));
            assert.ok(client.publishWebResources.calledOnceWith(['new-id-1']));
        });

        it('skips the file without error when the user declines to create it', async () => {
            const fileUri = writeFile('skip.js', 'content');
            client.getWebResourceIdByName.resolves(undefined);
            sinon.stub(vscodeMock.window, 'showWarningMessage').resolves('Cancel');
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage');
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage');

            await publishWebResources(
                [fileUri],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.ok(client.createWebResource.notCalled);
            assert.ok(infoStub.notCalled);
            assert.ok(errStub.notCalled);
            assert.ok(client.publishWebResources.notCalled);
        });

        it('proceeds without a solution association when getSolutions rejects', async () => {
            const fileUri = writeFile('nosol.js', 'content');
            client.getWebResourceIdByName.resolves(undefined);
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage');
            warnStub.onCall(0).resolves('Create');
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('No Sol');
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves({ type: 3 });
            client.getSolutions.rejects(new Error('network down'));
            client.createWebResource.resolves('new-id-2');

            await publishWebResources(
                [fileUri],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.ok(client.createWebResource.calledOnce);
            assert.ok(client.addSolutionComponent.notCalled);
            assert.ok(client.publishWebResources.calledOnceWith(['new-id-2']));
        });

        it('reports both published and failed counts when some files fail', async () => {
            const fileA = writeFile('ok.js', 'ok');
            const fileB = writeFile('bad.js', 'bad');
            client.getWebResourceIdByName.callsFake(async (name: string) => (name === 'ok.js' ? 'id-ok' : 'id-bad'));
            client.updateWebResourceContent.callsFake(async (id: string) => {
                if (id === 'id-bad') { throw new Error('server rejected'); }
            });
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage');

            await publishWebResources(
                [fileA, fileB],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.ok(errStub.calledOnce);
            assert.match(errStub.firstCall.args[0], /1 published, 1 failed/);
            assert.ok(client.publishWebResources.calledOnceWith(['id-ok']));
        });

        it('shows an information message with the published count when all succeed', async () => {
            const fileA = writeFile('ok1.js', 'ok');
            const fileB = writeFile('ok2.js', 'ok');
            client.getWebResourceIdByName.resolves('some-id');
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage');

            await publishWebResources(
                [fileA, fileB],
                connected as unknown as ConnectionManager,
                client as unknown as DataverseClient,
            );

            assert.ok(infoStub.calledOnce);
            assert.match(infoStub.firstCall.args[0], /Published 2 web resource\(s\)\./);
        });

        // ── publishWebResourcesCommand ──────────────────────────────────────

        it('publishWebResourcesCommand: not connected -> error, no candidate lookup', async () => {
            const findFilesSpy = sinon.spy(vscodeMock.workspace, 'findFiles');
            const errStub = sinon.stub(vscodeMock.window, 'showErrorMessage');

            await publishWebResourcesCommand({ isConnected: false } as unknown as ConnectionManager, client as unknown as DataverseClient);

            assert.ok(errStub.calledOnce);
            assert.ok(findFilesSpy.notCalled);
        });

        it('publishWebResourcesCommand: warns when no candidate files are found', async () => {
            sinon.stub(vscodeMock.workspace, 'findFiles').resolves([]);
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage');

            await publishWebResourcesCommand(connected as unknown as ConnectionManager, client as unknown as DataverseClient);

            assert.ok(warnStub.calledOnce);
            assert.match(warnStub.firstCall.args[0], /No files found under the configured web resources root folder/);
        });

        it('publishWebResourcesCommand: cancelling the quick pick does nothing further', async () => {
            const fileUri = writeFile('cmd.js', 'x');
            sinon.stub(vscodeMock.workspace, 'findFiles').resolves([fileUri]);
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);

            await publishWebResourcesCommand(connected as unknown as ConnectionManager, client as unknown as DataverseClient);

            assert.ok(client.getWebResourceIdByName.notCalled);
        });

        it('publishWebResourcesCommand: happy path runs publish for the selected picks', async () => {
            const fileUri = writeFile('cmd2.js', 'x');
            sinon.stub(vscodeMock.workspace, 'findFiles').resolves([fileUri]);
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves([{ label: 'cmd2.js', uri: fileUri }]);
            client.getWebResourceIdByName.resolves('id-cmd');

            await publishWebResourcesCommand(connected as unknown as ConnectionManager, client as unknown as DataverseClient);

            assert.ok(client.publishWebResources.calledOnceWith(['id-cmd']));
        });
    });

    // ── configureWebResourcesCommand ─────────────────────────────────────────

    describe('configureWebResourcesCommand', () => {
        const WORKSPACE_ROOT = path.resolve('/workspace');
        let workspaceFolder: { uri: vscodeMock.Uri; name: string; index: number };

        beforeEach(() => {
            workspaceFolder = { uri: vscodeMock.Uri.file(WORKSPACE_ROOT), name: 'ws', index: 0 };
        });

        it('warns and returns when no workspace folder is open', async () => {
            vscodeMock.workspace.workspaceFolders = undefined;
            const warnStub = sinon.stub(vscodeMock.window, 'showWarningMessage').resolves(undefined);
            const createInputBoxSpy = sinon.spy(vscodeMock.window, 'createInputBox');

            await configureWebResourcesCommand();

            assert.ok(warnStub.calledOnce);
            assert.match(warnStub.firstCall.args[0], /Open a workspace folder/);
            assert.ok(createInputBoxSpy.notCalled);
        });

        // Drives the InputBox + showInputBox choreography to completion.
        async function runHappyPath(rootValue: string, prefixInput: string) {
            vscodeMock.workspace.workspaceFolders = [workspaceFolder];
            vscodeMock.__setConfig(CONFIG_SECTION, {});

            let box: InstanceType<typeof vscodeMock.InputBoxMock> | undefined;
            sinon.stub(vscodeMock.window, 'createInputBox').callsFake(() => {
                box = new vscodeMock.InputBoxMock();
                return box;
            });
            sinon.stub(vscodeMock.window, 'showInputBox').resolves(prefixInput);
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const resultPromise = configureWebResourcesCommand();
            assert.ok(box, 'expected createInputBox to have been called synchronously');
            box!.value = rootValue;
            box!.triggerAccept();

            await resultPromise;

            return { config: vscodeMock.workspace.getConfiguration(CONFIG_SECTION), infoStub };
        }

        it('updates rootFolder and namePrefix on the full happy path', async () => {
            const { config, infoStub } = await runHappyPath('mywebresources', 'new_');

            assert.strictEqual(config.get('rootFolder'), 'mywebresources');
            assert.strictEqual(config.get('namePrefix'), 'new_/');
            assert.ok(infoStub.calledOnce);
        });

        it('normalizes a prefix with no trailing slash by appending one', async () => {
            const { config } = await runHappyPath('mywebresources', 'new');
            assert.strictEqual(config.get('namePrefix'), 'new/');
        });

        it('normalizes a blank/whitespace-only prefix to an empty string', async () => {
            const { config } = await runHappyPath('mywebresources', '   ');
            assert.strictEqual(config.get('namePrefix'), '');
        });

        it('cancelling the root-folder input box (hide without accept) exits early', async () => {
            vscodeMock.workspace.workspaceFolders = [workspaceFolder];
            vscodeMock.__setConfig(CONFIG_SECTION, { rootFolder: 'webresources', namePrefix: '' });

            let box: InstanceType<typeof vscodeMock.InputBoxMock> | undefined;
            sinon.stub(vscodeMock.window, 'createInputBox').callsFake(() => {
                box = new vscodeMock.InputBoxMock();
                return box;
            });
            const inputBoxSpy = sinon.spy(vscodeMock.window, 'showInputBox');
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage');

            const resultPromise = configureWebResourcesCommand();
            assert.ok(box);
            box!.hide();

            await resultPromise;

            assert.ok(inputBoxSpy.notCalled);
            assert.ok(infoStub.notCalled);
            const config = vscodeMock.workspace.getConfiguration(CONFIG_SECTION);
            assert.strictEqual(config.get('rootFolder'), 'webresources');
        });

        it('cancelling the name-prefix input box exits early without updating config', async () => {
            vscodeMock.workspace.workspaceFolders = [workspaceFolder];
            vscodeMock.__setConfig(CONFIG_SECTION, { rootFolder: 'webresources', namePrefix: '' });

            let box: InstanceType<typeof vscodeMock.InputBoxMock> | undefined;
            sinon.stub(vscodeMock.window, 'createInputBox').callsFake(() => {
                box = new vscodeMock.InputBoxMock();
                return box;
            });
            sinon.stub(vscodeMock.window, 'showInputBox').resolves(undefined);
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage');

            const resultPromise = configureWebResourcesCommand();
            assert.ok(box);
            box!.value = 'mywebresources';
            box!.triggerAccept();

            await resultPromise;

            assert.ok(infoStub.notCalled);
            const config = vscodeMock.workspace.getConfiguration(CONFIG_SECTION);
            assert.strictEqual(config.get('rootFolder'), 'webresources');
        });
    });
});
