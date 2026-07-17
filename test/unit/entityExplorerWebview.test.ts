import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscodeMock from '../mocks/vscode';
import { EntityExplorerWebviewProvider } from '../../src/entityExplorerWebview';
import type { ConnectionManager, D365Connection, DefaultSolutionRef } from '../../src/connectionManager';
import type { DataverseClient, AttributeDefinition, OptionValue, EntityDefinition, Solution } from '../../src/dataverseClient';
import type { EntityCache } from '../../src/entityCache';

// ── Fixtures / fakes ─────────────────────────────────────────────────────────

function attr(overrides: Partial<AttributeDefinition>): AttributeDefinition {
    return {
        logicalName: 'field',
        schemaName: 'Field',
        displayName: 'Field',
        attributeType: 'String',
        isPrimaryId: false,
        isPrimaryName: false,
        ...overrides,
    };
}

function fakeConnection(): D365Connection {
    return { environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user' };
}

interface FakeConnectionManager {
    cm: ConnectionManager;
    emitter: { fire: (conn: D365Connection | undefined) => void };
    state: { isConnected: boolean; isRestoring: boolean };
    connect: sinon.SinonStub;
    getDefaultSolution: sinon.SinonStub;
    setDefaultSolution: sinon.SinonStub;
}

function makeConnectionManager(overrides: Partial<{ isConnected: boolean; isRestoring: boolean }> = {}): FakeConnectionManager {
    const state = { isConnected: false, isRestoring: false, ...overrides };
    // Mirrors how the real ConnectionManager sets `_connection` before firing -- so code reading
    // `connectionManager.connection` synchronously inside the fired handler sees the new value.
    let connection: D365Connection | undefined = state.isConnected ? fakeConnection() : undefined;
    const rawEmitter = new vscodeMock.EventEmitter<D365Connection | undefined>();
    const connect = sinon.stub().resolves();
    const getDefaultSolution = sinon.stub().returns(undefined);
    const setDefaultSolution = sinon.stub().resolves();
    const cm = {
        onDidChangeConnection: rawEmitter.event,
        connect,
        getDefaultSolution,
        setDefaultSolution,
        get connection() { return connection; },
        get isConnected() { return state.isConnected; },
        get isRestoring() { return state.isRestoring; },
    } as unknown as ConnectionManager;
    const emitter = {
        fire: (conn: D365Connection | undefined) => {
            connection = conn;
            rawEmitter.fire(conn);
        },
    };
    return { cm, emitter, state, connect, getDefaultSolution, setDefaultSolution };
}

function makeEntityCache(initial?: EntityDefinition[]): {
    entityCache: EntityCache;
    get: sinon.SinonStub;
    set: sinon.SinonStub;
    getSolutionEntityIds: sinon.SinonStub;
    setSolutionEntityIds: sinon.SinonStub;
} {
    const get = sinon.stub().returns(initial);
    const set = sinon.stub().resolves();
    const getSolutionEntityIds = sinon.stub().returns(undefined);
    const setSolutionEntityIds = sinon.stub().resolves();
    return {
        entityCache: { get, set, getSolutionEntityIds, setSolutionEntityIds } as unknown as EntityCache,
        get, set, getSolutionEntityIds, setSolutionEntityIds,
    };
}

interface FakeClient {
    client: DataverseClient;
    getEntities: sinon.SinonStub;
    getAttributes: sinon.SinonStub;
    getAttributeOptions: sinon.SinonStub;
    getSolutions: sinon.SinonStub;
    getSolutionEntityIds: sinon.SinonStub;
}

function makeClient(): FakeClient {
    const getEntities = sinon.stub();
    const getAttributes = sinon.stub();
    const getAttributeOptions = sinon.stub();
    const getSolutions = sinon.stub();
    const getSolutionEntityIds = sinon.stub();
    const client = {
        getEntities, getAttributes, getAttributeOptions, getSolutions, getSolutionEntityIds,
    } as unknown as DataverseClient;
    return { client, getEntities, getAttributes, getAttributeOptions, getSolutions, getSolutionEntityIds };
}

type MessageHandler = (msg: Record<string, unknown>) => Promise<void> | void;

// Stand-in for context.extensionUri passed to the provider.
const EXT_URI = vscodeMock.Uri.file('/ext');

function makeView() {
    let handler: MessageHandler | undefined;
    const postMessage = sinon.stub();
    const view = {
        webview: {
            options: undefined as unknown,
            html: '',
            cspSource: 'vscode-webview://test',
            asWebviewUri: (uri: vscodeMock.Uri) => uri,
            postMessage,
            onDidReceiveMessage: (cb: MessageHandler) => { handler = cb; return new vscodeMock.Disposable(); },
        },
    };
    return { view, postMessage, getHandler: () => handler! };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EntityExplorerWebviewProvider', () => {
    afterEach(() => {
        sinon.restore();
        vscodeMock.resetVscodeMock();
    });

    // ── Constructor ───────────────────────────────────────────────────────

    describe('constructor / connection-change wiring', () => {
        it('does not throw when the connection changes before a view is attached', async () => {
            const { cm, emitter } = makeConnectionManager();
            const { client, getEntities } = makeClient();
            getEntities.resolves([]);
            new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);

            assert.doesNotThrow(() => emitter.fire(fakeConnection()));
            await flush();
            assert.strictEqual(getEntities.callCount, 1, 'entities are still (re)loaded even with no view attached');
        });

        it('does not reload entities when the connection is cleared (undefined)', async () => {
            const { cm, emitter } = makeConnectionManager();
            const { client, getEntities } = makeClient();
            new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);

            emitter.fire(undefined);
            await flush();
            assert.strictEqual(getEntities.callCount, 0);
        });

        it('posts connectionState and (re)loads entities once a view is attached', async () => {
            const { cm, emitter } = makeConnectionManager();
            const { client, getEntities } = makeClient();
            getEntities.resolves([{ metadataId: '1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false }] as EntityDefinition[]);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            emitter.fire(fakeConnection());

            assert.ok(postMessage.calledWith({ type: 'connectionState', connected: true, restoring: false }));
            assert.ok(postMessage.calledWith({ type: 'entitiesLoading' }));

            await flush();

            assert.ok(postMessage.calledWith({ type: 'entities', data: sinon.match.array }));
        });

        it('posts connectionState with connected:false and does not load entities when the connection is cleared', () => {
            const { cm, emitter } = makeConnectionManager();
            const { client, getEntities } = makeClient();
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            emitter.fire(undefined);

            assert.ok(postMessage.calledWith({ type: 'connectionState', connected: false, restoring: false }));
            assert.strictEqual(getEntities.callCount, 0);
        });
    });

    // ── resolveWebviewView ───────────────────────────────────────────────────

    describe('resolveWebviewView', () => {
        it('enables scripts, scopes local resource roots, sets non-empty html, and registers a message handler', () => {
            const { cm } = makeConnectionManager();
            const { client } = makeClient();
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, getHandler } = makeView();

            provider.resolveWebviewView(view as any);

            const options = view.webview.options as { enableScripts: boolean; localResourceRoots: unknown[] };
            assert.strictEqual(options.enableScripts, true);
            assert.strictEqual(options.localResourceRoots.length, 2);
            assert.ok(view.webview.html.includes('<!DOCTYPE'));
            assert.ok(view.webview.html.includes('<html'));
            assert.ok(view.webview.html.includes('entityExplorer.js'), 'loads the bundled React app');
            assert.strictEqual(typeof getHandler(), 'function');
        });
    });

    // ── handleMessage via the captured handler ──────────────────────────────

    describe('message handling', () => {
        function setup(connState: Partial<{ isConnected: boolean; isRestoring: boolean }> = {}) {
            const connMgr = makeConnectionManager(connState);
            const clientFake = makeClient();
            const provider = new EntityExplorerWebviewProvider(connMgr.cm, clientFake.client, EXT_URI, makeEntityCache().entityCache);
            const viewFake = makeView();
            provider.resolveWebviewView(viewFake.view as any);
            return { provider, ...connMgr, ...clientFake, ...viewFake };
        }

        it("'ready' posts connectionState (disconnected) and does not load entities", async () => {
            const { getHandler, postMessage, getEntities } = setup({ isConnected: false, isRestoring: false });
            await getHandler()({ type: 'ready' });

            assert.ok(postMessage.calledWith({ type: 'connectionState', connected: false, restoring: false }));
            assert.strictEqual(getEntities.callCount, 0);
        });

        it("'ready' posts connectionState (connected) and loads+posts entities, loading message first", async () => {
            const { getHandler, postMessage, getEntities } = setup({ isConnected: true, isRestoring: false });
            getEntities.resolves([{ metadataId: '1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false }]);

            // sendEntities is fire-and-forget from the 'ready' handler (so it can't delay the solution
            // filter below it), so its own posts land asynchronously after the handler call resolves.
            await getHandler()({ type: 'ready' });
            await flush();

            const loadingIdx = postMessage.getCalls().findIndex(c => (c.args[0] as any).type === 'entitiesLoading');
            const entitiesIdx = postMessage.getCalls().findIndex(c => (c.args[0] as any).type === 'entities');
            assert.ok(postMessage.calledWith({ type: 'connectionState', connected: true, restoring: false }));
            assert.ok(loadingIdx >= 0 && entitiesIdx > loadingIdx, 'entitiesLoading must post before entities');
            assert.ok(postMessage.calledWithMatch({ type: 'entities', data: sinon.match.array }));
        });

        it("'ready' posts entitiesError when getEntities rejects", async () => {
            const { getHandler, postMessage, getEntities } = setup({ isConnected: true });
            getEntities.rejects(new Error('boom'));

            await getHandler()({ type: 'ready' });
            await flush();

            assert.ok(postMessage.calledWith({ type: 'entitiesError', message: 'boom' }));
        });

        it("'ready' also (re)applies the default solution filter, recovering a post dropped before this view attached", async () => {
            const { getHandler, postMessage, getEntities, getSolutionEntityIds, getDefaultSolution } = setup({ isConnected: true });
            getEntities.resolves([]);
            getDefaultSolution.returns({ solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' });
            getSolutionEntityIds.resolves(new Set(['e1']));

            await getHandler()({ type: 'ready' });
            await flush();

            assert.ok(getSolutionEntityIds.calledWith('s1'));
            assert.ok(postMessage.calledWith({ type: 'solutionFilter', name: 'Solution One', entityIds: ['e1'] }));
        });

        it("'ready' applies the solution filter without waiting for sendEntities' own background refresh to finish", async () => {
            // Regression test: sendEntities() doesn't resolve until its background refresh completes
            // even on a cache hit (it posts the cached list synchronously first), so the 'ready' handler
            // must not await it before applying the solution filter -- otherwise the filter is delayed
            // by however long that entity refresh takes, which is exactly the bug this guards against.
            const { cm, getDefaultSolution } = makeConnectionManager({ isConnected: true });
            const { client, getEntities, getSolutionEntityIds } = makeClient();
            const defaultSolution: DefaultSolutionRef = { solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' };
            getDefaultSolution.returns(defaultSolution);
            getSolutionEntityIds.resolves(new Set(['e1']));

            let resolveEntities!: (v: EntityDefinition[]) => void;
            getEntities.returns(new Promise<EntityDefinition[]>(resolve => { resolveEntities = resolve; }));

            const { entityCache } = makeEntityCache([{ metadataId: '1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false }]);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage, getHandler } = makeView();
            provider.resolveWebviewView(view as any);

            await getHandler()({ type: 'ready' });
            await flush();

            // getEntities' promise is still unresolved (sendEntities' background refresh is stuck),
            // but the solution filter must already have been applied regardless.
            assert.ok(postMessage.calledWith({ type: 'solutionFilter', name: 'Solution One', entityIds: ['e1'] }));

            resolveEntities([]);
            await flush();
        });

        it("'ready' does not touch the solution filter when no default solution is set", async () => {
            const { getHandler, getEntities, getSolutionEntityIds } = setup({ isConnected: true });
            getEntities.resolves([]);

            await getHandler()({ type: 'ready' });

            assert.strictEqual(getSolutionEntityIds.callCount, 0);
        });

        it("'connect' delegates to connectionManager.connect()", async () => {
            const { getHandler, connect } = setup();
            await getHandler()({ type: 'connect' });
            assert.strictEqual(connect.callCount, 1);
        });

        it("RPC 'getAttributes' resolves with a matching-id response on success", async () => {
            const { getHandler, postMessage, getAttributes } = setup();
            const attrs = [attr({ logicalName: 'name' })];
            getAttributes.resolves(attrs);

            await getHandler()({ kind: 'request', id: 7, op: 'getAttributes', params: { entityLogicalName: 'account' } });

            assert.ok(getAttributes.calledWith('account'));
            assert.ok(postMessage.calledWith({ kind: 'response', id: 7, ok: true, data: attrs }));
        });

        it("RPC 'getAttributes' resolves with an error response on rejection", async () => {
            const { getHandler, postMessage, getAttributes } = setup();
            getAttributes.rejects(new Error('nope'));

            await getHandler()({ kind: 'request', id: 8, op: 'getAttributes', params: { entityLogicalName: 'account' } });

            assert.ok(postMessage.calledWith({ kind: 'response', id: 8, ok: false, error: 'nope' }));
        });

        it("RPC responds with an error for an unknown op", async () => {
            const { getHandler, postMessage } = setup();

            await getHandler()({ kind: 'request', id: 9, op: 'bogusOp', params: {} });

            assert.ok(postMessage.calledWithMatch({ kind: 'response', id: 9, ok: false }));
        });

        it("'showSolutionPicker' loads solutions, shows a quick pick, and posts solutionFilter on selection", async () => {
            const { getHandler, postMessage, getSolutions, getSolutionEntityIds } = setup();
            const solutions: Solution[] = [{ solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' }];
            getSolutions.resolves(solutions);
            getSolutionEntityIds.resolves(new Set(['e1', 'e2']));
            const quickPickStub = sinon.stub(vscodeMock.window, 'showQuickPick').callsFake(async (items: any) => items[0]);

            await getHandler()({ type: 'showSolutionPicker' });

            assert.strictEqual(quickPickStub.callCount, 1);
            assert.ok(getSolutionEntityIds.calledWith('s1'));
            assert.ok(postMessage.calledWith({ type: 'solutionFilter', name: 'Solution One', entityIds: ['e1', 'e2'] }));
        });

        it("'showSolutionPicker' exits quietly when the quick pick is dismissed", async () => {
            const { getHandler, postMessage, getSolutions, getSolutionEntityIds } = setup();
            getSolutions.resolves([{ solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' }]);
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);

            await getHandler()({ type: 'showSolutionPicker' });

            assert.strictEqual(getSolutionEntityIds.callCount, 0);
            assert.ok(!postMessage.getCalls().some(c => (c.args[0] as any).type === 'solutionFilter'));
        });

        it("'showSolutionPicker' shows an error when loading solutions fails", async () => {
            const { getHandler, getSolutions } = setup();
            getSolutions.rejects(new Error('solutions-down'));
            const showError = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            await getHandler()({ type: 'showSolutionPicker' });

            assert.ok(showError.calledWithMatch(/Failed to load solutions: solutions-down/));
        });

        it("'makeInterface' delegates to provider.makeInterface with the message payload", async () => {
            const { provider, getHandler } = setup();
            const spy = sinon.stub(provider, 'makeInterface').resolves();

            await getHandler()({ type: 'makeInterface', entityLogicalName: 'account', entityDisplayName: 'Account' });

            assert.ok(spy.calledWith('account', 'Account'));
        });

        it("'makeEnum' delegates to provider.makeEnum with the message payload", async () => {
            const { provider, getHandler } = setup();
            const spy = sinon.stub(provider, 'makeEnum').resolves();

            await getHandler()({
                type: 'makeEnum',
                entityLogicalName: 'account',
                attributeLogicalName: 'statuscode',
                attributeDisplayName: 'Status Reason',
                attributeType: 'Status',
            });

            assert.ok(spy.calledWith('account', 'statuscode', 'Status Reason', 'Status'));
        });

        it('ignores an unrecognized message type without throwing or posting', async () => {
            const { getHandler, postMessage } = setup();
            await assert.doesNotReject(async () => getHandler()({ type: 'somethingUnknown' }));
            assert.strictEqual(postMessage.callCount, 0);
        });

        it("the real onDidReceiveMessage wrapper catches a thrown/rejected handler and shows a 'D365 webview error'", async () => {
            const { getHandler, connect } = setup();
            connect.rejects(new Error('conn fail'));
            const showError = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            // Go through the actual wrapper registered in resolveWebviewView (not handleMessage directly).
            await getHandler()({ type: 'connect' });

            assert.ok(showError.calledWithMatch(/D365 webview error: conn fail/));
        });
    });

    // ── makeInterface ────────────────────────────────────────────────────────

    describe('makeInterface', () => {
        function attributesFixture(): AttributeDefinition[] {
            return [
                attr({ logicalName: 'accountid', displayName: 'Account', attributeType: 'Uniqueidentifier', isPrimaryId: true }),
                attr({ logicalName: 'name', displayName: 'Account Name', attributeType: 'String', isPrimaryName: true }),
                attr({ logicalName: 'statuscode', displayName: 'Status Reason', attributeType: 'Status' }),
            ];
        }

        it('loads fields, lets the user pick a subset, resolves option sets, and opens the generated document', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributes, getAttributeOptions } = makeClient();
            getAttributes.resolves(attributesFixture());
            getAttributeOptions.resolves([{ value: 1, label: 'Open' }, { value: 2, label: 'Closed' }] as OptionValue[]);

            sinon.stub(vscodeMock.window, 'showQuickPick').callsFake(async (items: any) => items);
            const openTextDocument = sinon.spy(vscodeMock.workspace, 'openTextDocument');
            const showTextDocument = sinon.stub(vscodeMock.window, 'showTextDocument').resolves(undefined);

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeInterface('account', 'Account');

            assert.ok(getAttributes.calledWith('account'));
            assert.ok(getAttributeOptions.calledWith('account', 'statuscode', 'Status'));
            assert.strictEqual(openTextDocument.callCount, 1);

            const docArg: any = openTextDocument.firstCall.args[0];
            assert.strictEqual(docArg.language, 'typescript');
            assert.match(docArg.content, /export interface Account \{/);
            assert.match(docArg.content, /export const enum StatusReason/);
            assert.match(docArg.content, /statuscode: StatusReason;/);

            assert.strictEqual(showTextDocument.callCount, 1);
        });

        it('shows an error and stops when loading fields fails', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributes } = makeClient();
            getAttributes.rejects(new Error('fields-down'));
            const showError = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const quickPick = sinon.stub(vscodeMock.window, 'showQuickPick');

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeInterface('account', 'Account');

            assert.ok(showError.calledWithMatch(/Failed to load fields: fields-down/));
            assert.strictEqual(quickPick.callCount, 0);
        });

        it('exits early without generating anything when the quick pick is dismissed (undefined)', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributes, getAttributeOptions } = makeClient();
            getAttributes.resolves(attributesFixture());
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);
            const openTextDocument = sinon.spy(vscodeMock.workspace, 'openTextDocument');

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeInterface('account', 'Account');

            assert.strictEqual(openTextDocument.callCount, 0);
            assert.strictEqual(getAttributeOptions.callCount, 0);
        });

        it('exits early without generating anything when the quick pick resolves an empty selection', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributes } = makeClient();
            getAttributes.resolves(attributesFixture());
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves([]);
            const openTextDocument = sinon.spy(vscodeMock.workspace, 'openTextDocument');

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeInterface('account', 'Account');

            assert.strictEqual(openTextDocument.callCount, 0);
        });

        it('shows an error and stops when loading option sets fails', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributes, getAttributeOptions } = makeClient();
            getAttributes.resolves(attributesFixture());
            getAttributeOptions.rejects(new Error('options-down'));
            sinon.stub(vscodeMock.window, 'showQuickPick').callsFake(async (items: any) => items);
            const showError = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const openTextDocument = sinon.spy(vscodeMock.workspace, 'openTextDocument');

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeInterface('account', 'Account');

            assert.ok(showError.calledWithMatch(/Failed to load option sets: options-down/));
            assert.strictEqual(openTextDocument.callCount, 0);
        });
    });

    // ── makeEnum ─────────────────────────────────────────────────────────────

    describe('makeEnum', () => {
        it('loads options and opens the generated enum document', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributeOptions } = makeClient();
            getAttributeOptions.resolves([{ value: 1, label: 'Open' }, { value: 2, label: 'In Progress' }] as OptionValue[]);
            const openTextDocument = sinon.spy(vscodeMock.workspace, 'openTextDocument');
            const showTextDocument = sinon.stub(vscodeMock.window, 'showTextDocument').resolves(undefined);

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeEnum('account', 'statuscode', 'Status Reason', 'Status');

            assert.ok(getAttributeOptions.calledWith('account', 'statuscode', 'Status'));
            assert.strictEqual(openTextDocument.callCount, 1);
            const docArg: any = openTextDocument.firstCall.args[0];
            assert.strictEqual(docArg.language, 'typescript');
            assert.match(docArg.content, /export const enum StatusReason \{/);
            assert.match(docArg.content, /Open = 1,/);
            assert.strictEqual(showTextDocument.callCount, 1);
        });

        it('shows an error and stops when loading options fails', async () => {
            const { cm } = makeConnectionManager();
            const { client, getAttributeOptions } = makeClient();
            getAttributeOptions.rejects(new Error('options-down'));
            const showError = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const openTextDocument = sinon.spy(vscodeMock.workspace, 'openTextDocument');

            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            await provider.makeEnum('account', 'statuscode', 'Status Reason', 'Status');

            assert.ok(showError.calledWithMatch(/Failed to load option set: options-down/));
            assert.strictEqual(openTextDocument.callCount, 0);
        });
    });

    // ── refresh ──────────────────────────────────────────────────────────────

    describe('refresh', () => {
        it('(re)loads and posts entities the same way as a connected "ready"', async () => {
            const { cm } = makeConnectionManager({ isConnected: true });
            const { client, getEntities } = makeClient();
            getEntities.resolves([{ metadataId: '1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false }]);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            provider.refresh();

            assert.ok(postMessage.calledWith({ type: 'entitiesLoading' }));
            await flush();
            assert.ok(postMessage.calledWithMatch({ type: 'entities', data: sinon.match.array }));
        });

        it('posts entitiesError when getEntities rejects', async () => {
            const { cm } = makeConnectionManager({ isConnected: true });
            const { client, getEntities } = makeClient();
            getEntities.rejects(new Error('down'));
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            provider.refresh();
            await flush();

            assert.ok(postMessage.calledWith({ type: 'entitiesError', message: 'down' }));
        });
    });

    // ── entity cache (cache-first + background refresh) ─────────────────────

    describe('entity cache', () => {
        it('serves cached entities immediately, then silently replaces them via entitiesRefreshed', async () => {
            const { cm } = makeConnectionManager({ isConnected: true });
            const { client, getEntities } = makeClient();
            const cachedEntities = [{ metadataId: 'cached-1', logicalName: 'contact', schemaName: 'Contact', displayName: 'Contact', isCustom: false }] as EntityDefinition[];
            const freshEntities = [{ metadataId: 'fresh-1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false }] as EntityDefinition[];
            getEntities.resolves(freshEntities);
            const { entityCache, set } = makeEntityCache(cachedEntities);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage, getHandler } = makeView();
            provider.resolveWebviewView(view as any);

            await getHandler()({ type: 'ready' });

            // Cached data renders immediately, without ever showing the blocking loading state.
            assert.ok(postMessage.calledWith({ type: 'entities', data: cachedEntities }));
            assert.ok(!postMessage.getCalls().some(c => (c.args[0] as any).type === 'entitiesLoading'));
            assert.ok(postMessage.calledWith({ type: 'entitiesRefreshing' }));

            await flush();

            assert.ok(postMessage.calledWith({ type: 'entitiesRefreshed', data: freshEntities }));
            assert.ok(set.calledWith('https://contoso.crm.dynamics.com', freshEntities));
        });

        it('does not post entitiesRefreshed (or an error) when the background refresh fails -- the stale cache stays', async () => {
            const { cm } = makeConnectionManager({ isConnected: true });
            const { client, getEntities } = makeClient();
            const cachedEntities = [{ metadataId: 'cached-1', logicalName: 'contact', schemaName: 'Contact', displayName: 'Contact', isCustom: false }] as EntityDefinition[];
            getEntities.rejects(new Error('offline'));
            const { entityCache } = makeEntityCache(cachedEntities);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage, getHandler } = makeView();
            provider.resolveWebviewView(view as any);

            await getHandler()({ type: 'ready' });
            await flush();

            assert.ok(!postMessage.getCalls().some(c => (c.args[0] as any).type === 'entitiesRefreshed'));
            assert.ok(!postMessage.getCalls().some(c => (c.args[0] as any).type === 'entitiesError'));
        });

        it('refresh() bypasses the cache and does a blocking fetch, updating the cache on success', async () => {
            const { cm } = makeConnectionManager({ isConnected: true });
            const { client, getEntities } = makeClient();
            const cachedEntities = [{ metadataId: 'cached-1', logicalName: 'contact', schemaName: 'Contact', displayName: 'Contact', isCustom: false }] as EntityDefinition[];
            const freshEntities = [{ metadataId: 'fresh-1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false }] as EntityDefinition[];
            getEntities.resolves(freshEntities);
            const { entityCache, set } = makeEntityCache(cachedEntities);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            provider.refresh();

            assert.ok(postMessage.calledWith({ type: 'entitiesLoading' }));
            await flush();

            assert.ok(postMessage.calledWith({ type: 'entities', data: freshEntities }));
            assert.ok(set.calledWith('https://contoso.crm.dynamics.com', freshEntities));
        });
    });

    // ── default solution (auto-apply on connect, persisted from the picker, clear round-trip) ──

    describe('default solution', () => {
        it('auto-applies the persisted default solution as a filter once connected (no cache yet)', async () => {
            // The auto-apply logic lives in the constructor's onDidChangeConnection subscription, so
            // it must be exercised via emitter.fire(...) -- not the 'ready' message handler, which only
            // (re)loads entities.
            const { cm, emitter, getDefaultSolution } = makeConnectionManager();
            const defaultSolution: DefaultSolutionRef = { solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' };
            getDefaultSolution.returns(defaultSolution);
            const { client, getEntities, getSolutionEntityIds } = makeClient();
            getEntities.resolves([]);
            getSolutionEntityIds.resolves(new Set(['e1']));
            const { entityCache, setSolutionEntityIds } = makeEntityCache();
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            emitter.fire(fakeConnection());
            await flush();

            assert.ok(getSolutionEntityIds.calledWith('s1'));
            assert.ok(postMessage.calledWith({ type: 'solutionFilter', name: 'Solution One', entityIds: ['e1'] }));
            assert.ok(setSolutionEntityIds.calledWith('https://contoso.crm.dynamics.com', 's1', ['e1']), 'populates the cache for next time');
        });

        it('applies a cached solution filter immediately, then silently refreshes it in the background', async () => {
            const { cm, emitter, getDefaultSolution } = makeConnectionManager();
            const defaultSolution: DefaultSolutionRef = { solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' };
            getDefaultSolution.returns(defaultSolution);
            const { client, getEntities, getSolutionEntityIds } = makeClient();
            getEntities.resolves([]);
            getSolutionEntityIds.resolves(new Set(['fresh-1']));
            const { entityCache, getSolutionEntityIds: getCachedIds, setSolutionEntityIds } = makeEntityCache();
            getCachedIds.returns(['cached-1']);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            emitter.fire(fakeConnection());
            await flush();

            const filterCalls = postMessage.getCalls().filter(c => (c.args[0] as any).type === 'solutionFilter');
            assert.strictEqual(filterCalls.length, 2, 'cached filter applied immediately, then replaced once the refresh completes');
            assert.deepStrictEqual(filterCalls[0].args[0], { type: 'solutionFilter', name: 'Solution One', entityIds: ['cached-1'] });
            assert.deepStrictEqual(filterCalls[1].args[0], { type: 'solutionFilter', name: 'Solution One', entityIds: ['fresh-1'] });
            assert.ok(setSolutionEntityIds.calledWith('https://contoso.crm.dynamics.com', 's1', ['fresh-1']));
        });

        it('keeps the cached solution filter applied if the background refresh fails', async () => {
            const { cm, emitter, getDefaultSolution } = makeConnectionManager();
            const defaultSolution: DefaultSolutionRef = { solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' };
            getDefaultSolution.returns(defaultSolution);
            const { client, getEntities, getSolutionEntityIds } = makeClient();
            getEntities.resolves([]);
            getSolutionEntityIds.rejects(new Error('offline'));
            const { entityCache, getSolutionEntityIds: getCachedIds, setSolutionEntityIds } = makeEntityCache();
            getCachedIds.returns(['cached-1']);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, entityCache);
            const { view, postMessage } = makeView();
            provider.resolveWebviewView(view as any);

            emitter.fire(fakeConnection());
            await flush();

            const filterCalls = postMessage.getCalls().filter(c => (c.args[0] as any).type === 'solutionFilter');
            assert.strictEqual(filterCalls.length, 1, 'no second post when the background refresh fails');
            assert.deepStrictEqual(filterCalls[0].args[0], { type: 'solutionFilter', name: 'Solution One', entityIds: ['cached-1'] });
            assert.ok(!setSolutionEntityIds.called);
        });

        it('does not apply any filter when no default solution is set', async () => {
            const { cm, emitter } = makeConnectionManager();
            const { client, getEntities, getSolutionEntityIds } = makeClient();
            getEntities.resolves([]);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view } = makeView();
            provider.resolveWebviewView(view as any);

            emitter.fire(fakeConnection());
            await flush();

            assert.strictEqual(getSolutionEntityIds.callCount, 0);
        });

        it("'showSolutionPicker' persists the chosen solution as the new default", async () => {
            const { cm, setDefaultSolution } = makeConnectionManager({ isConnected: true });
            const { client, getSolutions, getSolutionEntityIds } = makeClient();
            const solution: Solution = { solutionId: 's2', uniqueName: 'sol2', friendlyName: 'Solution Two' };
            getSolutions.resolves([solution]);
            getSolutionEntityIds.resolves(new Set(['e9']));
            sinon.stub(vscodeMock.window, 'showQuickPick').callsFake(async (items: any) => items[0]);
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, getHandler } = makeView();
            provider.resolveWebviewView(view as any);

            await getHandler()({ type: 'showSolutionPicker' });

            assert.ok(setDefaultSolution.calledOnceWith(solution));
        });

        it("'clearSolutionFilter' clears the persisted default solution", async () => {
            const { cm, setDefaultSolution } = makeConnectionManager({ isConnected: true });
            const { client } = makeClient();
            const provider = new EntityExplorerWebviewProvider(cm, client, EXT_URI, makeEntityCache().entityCache);
            const { view, getHandler } = makeView();
            provider.resolveWebviewView(view as any);

            await getHandler()({ type: 'clearSolutionFilter' });

            assert.ok(setDefaultSolution.calledOnceWith(undefined));
        });
    });
});
