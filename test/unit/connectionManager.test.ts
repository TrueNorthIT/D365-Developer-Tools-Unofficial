import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscodeMock from '../mocks/vscode';
import { ConnectionManager, D365Connection, StoredConnection } from '../../src/connectionManager';
import { UserAuthProvider } from '../../src/auth/userAuthProvider';
import { ClientCredentialsProvider } from '../../src/auth/clientCredentialsProvider';
import * as tenantDiscoveryModule from '../../src/auth/tenantDiscovery';

// ── Fake ExtensionContext ────────────────────────────────────────────────────

function makeContext() {
    const workspaceStateStore = new Map<string, unknown>();
    const globalStateStore = new Map<string, unknown>();
    const secretsStore = new Map<string, string>();

    return {
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
        _stores: { workspaceStateStore, globalStateStore, secretsStore },
    } as unknown as import('vscode').ExtensionContext & { _stores: unknown };
}

function fetchResponse(ok: boolean, body: unknown, opts: { status?: number; statusText?: string; headers?: Record<string, string> } = {}): Response {
    return {
        ok,
        status: opts.status ?? (ok ? 200 : 500),
        statusText: opts.statusText ?? '',
        headers: { get: (name: string) => opts.headers?.[name] ?? null },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}

const WHOAMI_OK = { UserId: 'user-1', BusinessUnitId: 'bu-1', OrganizationId: 'org-1' };

describe('ConnectionManager', () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
        fetchStub = sinon.stub(global as unknown as { fetch: typeof fetch }, 'fetch');
        fetchStub.resolves(fetchResponse(true, WHOAMI_OK));
    });

    afterEach(() => {
        sinon.restore();
        vscodeMock.resetVscodeMock();
    });

    describe('initial state', () => {
        it('starts disconnected and not restoring', () => {
            const cm = new ConnectionManager(makeContext());
            assert.strictEqual(cm.connection, undefined);
            assert.strictEqual(cm.isConnected, false);
            assert.strictEqual(cm.isRestoring, false);
        });

        it('getAccessToken rejects when nothing is connected', async () => {
            const cm = new ConnectionManager(makeContext());
            await assert.rejects(() => cm.getAccessToken(), /Not connected to a D365 environment/);
        });
    });

    describe('tryRestoreConnection', () => {
        it('does nothing when there is no stored connection', async () => {
            const cm = new ConnectionManager(makeContext());
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, false);
            assert.strictEqual(events.length, 0);
        });

        it('offers reconnect when a clientCredentials connection has no stored clientId', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'clientCredentials',
            } satisfies StoredConnection);

            const cm = new ConnectionManager(ctx);
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, false);
            assert.strictEqual(cm.isRestoring, false);
            assert.deepStrictEqual(events, [undefined]);
            assert.ok(infoStub.calledOnce);
            assert.match(infoStub.firstCall.args[0] as string, /Previously connected to/);
        });

        it('offers reconnect when the clientCredentials secret is missing from storage', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', clientId: 'client-1', authMode: 'clientCredentials',
            } satisfies StoredConnection);

            const cm = new ConnectionManager(ctx);
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, false);
        });

        it('restores a clientCredentials connection when the secret is present and auth succeeds', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', clientId: 'client-1', authMode: 'clientCredentials',
            } satisfies StoredConnection);
            await ctx.secrets.store('d365.clientSecret.https://contoso.crm.dynamics.com.client-1', 'super-secret');

            sinon.stub(ClientCredentialsProvider.prototype, 'getAccessToken').resolves('token-abc');
            const disposeSpy = sinon.stub(ClientCredentialsProvider.prototype, 'dispose');

            const cm = new ConnectionManager(ctx);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(cm.connection?.environmentUrl, 'https://contoso.crm.dynamics.com');
            assert.deepStrictEqual(cm.connection?.whoAmI, WHOAMI_OK);
            assert.strictEqual(events.length, 1);
            assert.ok(!disposeSpy.called);
        });

        it('offers reconnect when clientCredentials token acquisition fails', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', clientId: 'client-1', authMode: 'clientCredentials',
            } satisfies StoredConnection);
            await ctx.secrets.store('d365.clientSecret.https://contoso.crm.dynamics.com.client-1', 'super-secret');

            sinon.stub(ClientCredentialsProvider.prototype, 'getAccessToken').rejects(new Error('bad creds'));
            const disposeSpy = sinon.stub(ClientCredentialsProvider.prototype, 'dispose');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const cm = new ConnectionManager(ctx);
            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(disposeSpy.calledOnce);
        });

        it('offers reconnect when WhoAmI fails after successful clientCredentials auth', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', clientId: 'client-1', authMode: 'clientCredentials',
            } satisfies StoredConnection);
            await ctx.secrets.store('d365.clientSecret.https://contoso.crm.dynamics.com.client-1', 'super-secret');

            sinon.stub(ClientCredentialsProvider.prototype, 'getAccessToken').resolves('token-abc');
            const disposeSpy = sinon.stub(ClientCredentialsProvider.prototype, 'dispose');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
            fetchStub.resolves(fetchResponse(false, '', { status: 500, statusText: 'Server Error' }));

            const cm = new ConnectionManager(ctx);
            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(disposeSpy.calledOnce);
        });

        it('restores a user-auth connection silently when a session is already available', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            } satisfies StoredConnection);

            const getTokenStub = sinon.stub(UserAuthProvider.prototype, 'getAccessToken').resolves('token-xyz');

            const cm = new ConnectionManager(ctx);
            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(cm.connection?.authMode, 'user');
            // First call is the silent availability check, second is the real token fetch.
            assert.strictEqual(getTokenStub.callCount, 2);
            assert.strictEqual(getTokenStub.firstCall.args[0], true);
        });

        it('offers reconnect when no silent user-auth session is available', async () => {
            const ctx = makeContext();
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            } satisfies StoredConnection);

            sinon.stub(UserAuthProvider.prototype, 'getAccessToken').rejects(new Error('no session'));
            const disposeSpy = sinon.stub(UserAuthProvider.prototype, 'dispose');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const cm = new ConnectionManager(ctx);
            await cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(disposeSpy.calledOnce);
        });

        // ── Optimistic restore (a cached WhoAmI is present from a prior successful connect) ──────

        const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

        it('optimistically restores from a cached WhoAmI immediately, then re-verifies in the background', async () => {
            const ctx = makeContext();
            const cachedWhoAmI = { UserId: 'cached-user', BusinessUnitId: 'bu-1', OrganizationId: 'org-1' };
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user', whoAmI: cachedWhoAmI,
            });

            const getTokenStub = sinon.stub(UserAuthProvider.prototype, 'getAccessToken').resolves('token-xyz');

            const cm = new ConnectionManager(ctx);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            // For user auth there's no `await` before the optimistic fire, so tryRestoreConnection()
            // runs synchronously up through firing the cached connection -- calling it (without
            // awaiting yet) lets us observe that state before any of the background verification's
            // own awaits have had a chance to settle.
            const restorePromise = cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(cm.isRestoring, false);
            assert.deepStrictEqual(cm.connection?.whoAmI, cachedWhoAmI);
            assert.strictEqual(events.length, 1);

            await restorePromise;
            await flush();

            assert.strictEqual(cm.isConnected, true);
            assert.deepStrictEqual(cm.connection?.whoAmI, WHOAMI_OK, 'replaced by the real WhoAmI once background verification completes');
            assert.strictEqual(events.length, 2, 'a second event fires once the background verification confirms the connection');
            assert.deepStrictEqual(
                ctx.workspaceState.get('d365.connection'),
                { environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', clientId: undefined, authMode: 'user', whoAmI: WHOAMI_OK },
            );
        });

        it('rolls back to disconnected and offers reconnect when the background verification fails after an optimistic restore', async () => {
            const ctx = makeContext();
            const cachedWhoAmI = { UserId: 'cached-user', BusinessUnitId: 'bu-1', OrganizationId: 'org-1' };
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user', whoAmI: cachedWhoAmI,
            });

            sinon.stub(UserAuthProvider.prototype, 'getAccessToken').rejects(new Error('session expired'));
            const disposeSpy = sinon.stub(UserAuthProvider.prototype, 'dispose');
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const cm = new ConnectionManager(ctx);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            const restorePromise = cm.tryRestoreConnection();

            assert.strictEqual(cm.isConnected, true, 'still optimistically connected synchronously, before the background verification runs');

            await restorePromise;
            await flush();

            assert.strictEqual(cm.isConnected, false, 'rolled back once the background verification fails');
            assert.strictEqual(events.length, 2);
            assert.strictEqual(events[1], undefined);
            assert.ok(disposeSpy.calledOnce);
            assert.ok(infoStub.calledWithMatch(/Previously connected to/));
        });

        it('optimistically restores a clientCredentials connection from a cached WhoAmI, verifying in the background', async () => {
            const ctx = makeContext();
            const cachedWhoAmI = { UserId: 'cached-user', BusinessUnitId: 'bu-1', OrganizationId: 'org-1' };
            await ctx.workspaceState.update('d365.connection', {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', clientId: 'client-1', authMode: 'clientCredentials', whoAmI: cachedWhoAmI,
            });
            await ctx.secrets.store('d365.clientSecret.https://contoso.crm.dynamics.com.client-1', 'super-secret');
            sinon.stub(ClientCredentialsProvider.prototype, 'getAccessToken').resolves('token-abc');

            const cm = new ConnectionManager(ctx);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            // Unlike user auth, clientCredentials mode does an `await` (the secret lookup) before it
            // can even reach the optimistic-fire branch, so the two phases can't be reliably observed
            // as separate synchronous snapshots here -- just assert the end-to-end result.
            await cm.tryRestoreConnection();
            await flush();

            assert.strictEqual(cm.isConnected, true);
            assert.deepStrictEqual(cm.connection?.whoAmI, WHOAMI_OK);
            assert.strictEqual(events.length, 2, 'one optimistic fire plus one background-verified fire');
        });
    });

    describe('default solution', () => {
        function connectedContext(): { ctx: ReturnType<typeof makeContext>; cm: ConnectionManager } {
            const ctx = makeContext();
            const cm = new ConnectionManager(ctx);
            (cm as unknown as { _connection: D365Connection })._connection = {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            };
            return { ctx, cm };
        }

        it('returns undefined when nothing is connected', () => {
            const cm = new ConnectionManager(makeContext());
            assert.strictEqual(cm.getDefaultSolution(), undefined);
        });

        it('returns undefined when no default has been set for the current environment', () => {
            const { cm } = connectedContext();
            assert.strictEqual(cm.getDefaultSolution(), undefined);
        });

        it('persists and retrieves a default solution for the current environment', async () => {
            const { cm } = connectedContext();
            const solution = { solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' };

            await cm.setDefaultSolution(solution);

            assert.deepStrictEqual(cm.getDefaultSolution(), solution);
        });

        it('clears the default solution for the current environment when set to undefined', async () => {
            const { cm } = connectedContext();
            await cm.setDefaultSolution({ solutionId: 's1', uniqueName: 'sol1', friendlyName: 'Solution One' });

            await cm.setDefaultSolution(undefined);

            assert.strictEqual(cm.getDefaultSolution(), undefined);
        });

        it('keeps default solutions for different environments independent', async () => {
            const ctx = makeContext();
            const cm = new ConnectionManager(ctx);

            (cm as unknown as { _connection: D365Connection })._connection = { environmentUrl: 'https://a.crm.dynamics.com', tenantId: 't1', authMode: 'user' };
            await cm.setDefaultSolution({ solutionId: 's-a', uniqueName: 'sol-a', friendlyName: 'Solution A' });

            (cm as unknown as { _connection: D365Connection })._connection = { environmentUrl: 'https://b.crm.dynamics.com', tenantId: 't1', authMode: 'user' };
            assert.strictEqual(cm.getDefaultSolution(), undefined);
            await cm.setDefaultSolution({ solutionId: 's-b', uniqueName: 'sol-b', friendlyName: 'Solution B' });

            assert.deepStrictEqual(cm.getDefaultSolution(), { solutionId: 's-b', uniqueName: 'sol-b', friendlyName: 'Solution B' });

            (cm as unknown as { _connection: D365Connection })._connection = { environmentUrl: 'https://a.crm.dynamics.com', tenantId: 't1', authMode: 'user' };
            assert.deepStrictEqual(cm.getDefaultSolution(), { solutionId: 's-a', uniqueName: 'sol-a', friendlyName: 'Solution A' });
        });
    });

    describe('connect', () => {
        it('does nothing when the environment URL prompt is cancelled', async () => {
            vscodeMock.__setConfig('d365', {});
            sinon.stub(vscodeMock.window, 'showInputBox').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            await cm.connect();

            assert.strictEqual(cm.isConnected, false);
        });

        it('does nothing when the auth-mode picker is cancelled', async () => {
            vscodeMock.__setConfig('d365', {});
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('contoso.crm.dynamics.com');
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            await cm.connect();

            assert.strictEqual(cm.isConnected, false);
        });

        it('establishes a user-auth connection end to end, normalizing the URL and discovering the tenant', async () => {
            vscodeMock.__setConfig('d365', {});
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('contoso.crm.dynamics.com/');
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves({ value: 'user' });
            const discoverStub = sinon.stub(tenantDiscoveryModule, 'discoverTenantId').resolves('11111111-1111-1111-1111-111111111111');
            sinon.stub(UserAuthProvider.prototype, 'selectAccount').resolves('token-xyz');
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            await cm.connect();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(cm.connection?.environmentUrl, 'https://contoso.crm.dynamics.com');
            assert.strictEqual(cm.connection?.tenantId, '11111111-1111-1111-1111-111111111111');
            assert.strictEqual(cm.connection?.authMode, 'user');
            assert.deepStrictEqual(cm.connection?.whoAmI, WHOAMI_OK);
            assert.strictEqual(events.length, 1);
            assert.ok(discoverStub.calledOnceWith('https://contoso.crm.dynamics.com'));
            assert.ok(infoStub.calledWithMatch(/Connected to https:\/\/contoso\.crm\.dynamics\.com/));
        });

        it('uses configured values instead of prompting when available', async () => {
            vscodeMock.__setConfig('d365', {
                environmentUrl: 'contoso.crm.dynamics.com',
                authMode: 'user',
                tenantId: '22222222-2222-2222-2222-222222222222',
            });
            const inputBoxStub = sinon.stub(vscodeMock.window, 'showInputBox').resolves(undefined);
            const quickPickStub = sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);
            const discoverStub = sinon.stub(tenantDiscoveryModule, 'discoverTenantId').resolves('should-not-be-used');
            sinon.stub(UserAuthProvider.prototype, 'selectAccount').resolves('token-xyz');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            await cm.connect();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(cm.connection?.tenantId, '22222222-2222-2222-2222-222222222222');
            assert.ok(!inputBoxStub.called, 'should not prompt for environment URL when configured');
            assert.ok(!quickPickStub.called, 'should not prompt for auth mode when configured');
            assert.ok(!discoverStub.called, 'should not discover tenant when configured');
        });

        it('shows an error and aborts when tenant discovery fails', async () => {
            vscodeMock.__setConfig('d365', {});
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('contoso.crm.dynamics.com');
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves({ value: 'user' });
            sinon.stub(tenantDiscoveryModule, 'discoverTenantId').rejects(new Error('unreachable'));
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            await cm.connect();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(errorStub.calledWithMatch(/Tenant discovery failed/));
        });

        it('prompts for a client ID in clientCredentials mode and aborts if cancelled', async () => {
            vscodeMock.__setConfig('d365', { authMode: 'clientCredentials', tenantId: 't1' });
            sinon.stub(vscodeMock.window, 'showInputBox').resolves(undefined); // environmentUrl prompt then clientId prompt
            // environmentUrl isn't configured, so the first showInputBox call is for it and returns undefined -> should abort before even reaching clientId.
            const cm = new ConnectionManager(makeContext());
            await cm.connect();
            assert.strictEqual(cm.isConnected, false);
        });

        it('establishes a clientCredentials connection, prompting for and storing the secret', async () => {
            vscodeMock.__setConfig('d365', { authMode: 'clientCredentials', tenantId: 't1' });
            const inputBox = sinon.stub(vscodeMock.window, 'showInputBox');
            inputBox.onCall(0).resolves('contoso.crm.dynamics.com'); // environment URL
            inputBox.onCall(1).resolves('client-123'); // client id
            inputBox.onCall(2).resolves('my-secret'); // client secret

            sinon.stub(ClientCredentialsProvider.prototype, 'getAccessToken').resolves('token-abc');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const ctx = makeContext();
            const cm = new ConnectionManager(ctx);
            await cm.connect();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(cm.connection?.authMode, 'clientCredentials');
            assert.strictEqual(cm.connection?.clientId, 'client-123');
            assert.strictEqual(
                await ctx.secrets.get('d365.clientSecret.https://contoso.crm.dynamics.com.client-123'),
                'my-secret',
            );
        });

        it('reuses an already-stored client secret without prompting for it again', async () => {
            vscodeMock.__setConfig('d365', { authMode: 'clientCredentials', tenantId: 't1' });
            const inputBox = sinon.stub(vscodeMock.window, 'showInputBox');
            inputBox.onCall(0).resolves('contoso.crm.dynamics.com');
            inputBox.onCall(1).resolves('client-123');

            sinon.stub(ClientCredentialsProvider.prototype, 'getAccessToken').resolves('token-abc');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            const ctx = makeContext();
            await ctx.secrets.store('d365.clientSecret.https://contoso.crm.dynamics.com.client-123', 'existing-secret');
            const cm = new ConnectionManager(ctx);
            await cm.connect();

            assert.strictEqual(cm.isConnected, true);
            assert.strictEqual(inputBox.callCount, 2, 'should not prompt a third time for the secret');
        });

        it('shows an error and disposes the auth provider when authentication fails', async () => {
            vscodeMock.__setConfig('d365', {});
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('contoso.crm.dynamics.com');
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves({ value: 'user' });
            sinon.stub(tenantDiscoveryModule, 'discoverTenantId').resolves('11111111-1111-1111-1111-111111111111');
            sinon.stub(UserAuthProvider.prototype, 'selectAccount').rejects(new Error('sign-in cancelled'));
            const disposeSpy = sinon.stub(UserAuthProvider.prototype, 'dispose');
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            await cm.connect();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(errorStub.calledWithMatch(/Authentication failed/));
            assert.ok(disposeSpy.calledOnce);
        });

        it('shows an error and disposes the auth provider when WhoAmI fails', async () => {
            vscodeMock.__setConfig('d365', {});
            sinon.stub(vscodeMock.window, 'showInputBox').resolves('contoso.crm.dynamics.com');
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves({ value: 'user' });
            sinon.stub(tenantDiscoveryModule, 'discoverTenantId').resolves('11111111-1111-1111-1111-111111111111');
            sinon.stub(UserAuthProvider.prototype, 'selectAccount').resolves('token-xyz');
            const disposeSpy = sinon.stub(UserAuthProvider.prototype, 'dispose');
            fetchStub.resolves(fetchResponse(false, '', { status: 401, statusText: 'Unauthorized' }));
            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);

            const cm = new ConnectionManager(makeContext());
            await cm.connect();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(errorStub.calledWithMatch(/Connected but WhoAmI failed/));
            assert.ok(disposeSpy.calledOnce);
        });
    });

    describe('recent environments', () => {
        async function connectTo(cm: ConnectionManager, url: string) {
            vscodeMock.__setConfig('d365', { environmentUrl: url, authMode: 'user', tenantId: 't1' });
            sinon.stub(vscodeMock.window, 'showInputBox').resolves(undefined);
            sinon.stub(vscodeMock.window, 'showQuickPick').resolves(undefined);
            sinon.stub(UserAuthProvider.prototype, 'selectAccount').resolves('token');
            sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
            await cm.connect();
            sinon.restore();
            // fetch stub must persist across connects in this loop, so re-apply it.
            fetchStub = sinon.stub(global as unknown as { fetch: typeof fetch }, 'fetch').resolves(fetchResponse(true, WHOAMI_OK));
        }

        it('records the most recently connected environment first, capped at 5, de-duplicated', async () => {
            const ctx = makeContext();
            const cm = new ConnectionManager(ctx);

            for (const url of ['a.crm.dynamics.com', 'b.crm.dynamics.com', 'c.crm.dynamics.com', 'd.crm.dynamics.com', 'e.crm.dynamics.com', 'f.crm.dynamics.com']) {
                await connectTo(cm, url);
            }
            // Reconnect to "b" to move it to the front.
            await connectTo(cm, 'b.crm.dynamics.com');

            const recents = cm.getRecentEnvironments();
            assert.strictEqual(recents.length, 5);
            assert.strictEqual(recents[0].environmentUrl, 'https://b.crm.dynamics.com');
            assert.strictEqual(recents.filter(r => r.environmentUrl === 'https://b.crm.dynamics.com').length, 1);
        });
    });

    describe('switchAccount', () => {
        it('shows info and does nothing when not connected via user auth', async () => {
            const cm = new ConnectionManager(makeContext());
            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);

            await cm.switchAccount();

            assert.ok(infoStub.calledWithMatch(/only available for user sign-in/));
        });

        it('updates whoAmI and fires an event on success', async () => {
            const cm = new ConnectionManager(makeContext());
            const fakeProvider = new UserAuthProvider('https://contoso.crm.dynamics.com');
            sinon.stub(fakeProvider, 'selectAccount').resolves('new-token');
            (cm as unknown as { _authProvider: unknown })._authProvider = fakeProvider;
            (cm as unknown as { _connection: D365Connection })._connection = {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            };

            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            await cm.switchAccount();

            assert.deepStrictEqual(cm.connection?.whoAmI, WHOAMI_OK);
            assert.strictEqual(events.length, 1);
            assert.ok(infoStub.calledWithMatch(/Switched account/));
        });

        it('shows an error and leaves the connection unchanged when sign-in fails', async () => {
            const cm = new ConnectionManager(makeContext());
            const fakeProvider = new UserAuthProvider('https://contoso.crm.dynamics.com');
            sinon.stub(fakeProvider, 'selectAccount').rejects(new Error('cancelled'));
            (cm as unknown as { _authProvider: unknown })._authProvider = fakeProvider;
            (cm as unknown as { _connection: D365Connection })._connection = {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            };

            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            await cm.switchAccount();

            assert.ok(errorStub.calledWithMatch(/Sign-in failed/));
            assert.strictEqual(cm.connection?.whoAmI, undefined);
        });

        it('shows an error when WhoAmI fails after a successful account switch', async () => {
            const cm = new ConnectionManager(makeContext());
            const fakeProvider = new UserAuthProvider('https://contoso.crm.dynamics.com');
            sinon.stub(fakeProvider, 'selectAccount').resolves('new-token');
            (cm as unknown as { _authProvider: unknown })._authProvider = fakeProvider;
            (cm as unknown as { _connection: D365Connection })._connection = {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            };
            fetchStub.resolves(fetchResponse(false, '', { status: 500, statusText: 'err' }));

            const errorStub = sinon.stub(vscodeMock.window, 'showErrorMessage').resolves(undefined);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            await cm.switchAccount();

            assert.ok(errorStub.calledWithMatch(/Connected but WhoAmI failed/));
            assert.strictEqual(events.length, 0);
        });
    });

    describe('disconnect', () => {
        it('clears the connection, disposes the auth provider, and persists the change', async () => {
            const ctx = makeContext();
            const cm = new ConnectionManager(ctx);
            const fakeProvider = new UserAuthProvider('https://contoso.crm.dynamics.com');
            const disposeSpy = sinon.stub(fakeProvider, 'dispose');
            (cm as unknown as { _authProvider: unknown })._authProvider = fakeProvider;
            (cm as unknown as { _connection: D365Connection })._connection = {
                environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user',
            };
            await ctx.workspaceState.update('d365.connection', { environmentUrl: 'https://contoso.crm.dynamics.com', tenantId: 't1', authMode: 'user' });

            const infoStub = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
            const events: Array<D365Connection | undefined> = [];
            cm.onDidChangeConnection(c => events.push(c));

            cm.disconnect();
            // workspaceState.update is fire-and-forget (void) inside disconnect(); give the microtask queue a tick.
            await Promise.resolve();

            assert.strictEqual(cm.isConnected, false);
            assert.ok(disposeSpy.calledOnce);
            assert.deepStrictEqual(events, [undefined]);
            assert.strictEqual(ctx.workspaceState.get('d365.connection'), undefined);
            assert.ok(infoStub.calledWithMatch(/Disconnected/));
        });
    });
});
