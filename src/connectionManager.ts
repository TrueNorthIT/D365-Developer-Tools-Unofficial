import * as vscode from 'vscode';
import type { AuthProvider } from './auth/authProvider';
import { UserAuthProvider } from './auth/userAuthProvider';
import { ClientCredentialsProvider } from './auth/clientCredentialsProvider';
import { discoverTenantId } from './auth/tenantDiscovery';

export type AuthMode = 'user' | 'clientCredentials';

export interface D365Connection {
    environmentUrl: string;
    tenantId: string;
    clientId?: string;
    authMode: AuthMode;
    whoAmI?: WhoAmIResponse;
}

interface WhoAmIResponse {
    UserId: string;
    BusinessUnitId: string;
    OrganizationId: string;
}

export interface StoredConnection {
    environmentUrl: string;
    tenantId: string;
    clientId?: string;
    authMode: AuthMode;
}

const SECRET_KEY_PREFIX  = 'd365.clientSecret';
const WORKSPACE_STATE_KEY = 'd365.connection';
const RECENTS_STATE_KEY = 'd365.recentEnvironments';
const MAX_RECENTS = 5;

export class ConnectionManager {
    private _connection: D365Connection | undefined;
    private _authProvider: AuthProvider | undefined;
    private _isRestoring = false;

    private readonly _onDidChangeConnection = new vscode.EventEmitter<D365Connection | undefined>();
    readonly onDidChangeConnection = this._onDidChangeConnection.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    get connection(): D365Connection | undefined { return this._connection; }
    get isConnected(): boolean { return this._connection !== undefined; }
    get isRestoring(): boolean { return this._isRestoring; }

    async getAccessToken(): Promise<string> {
        if (!this._authProvider) {
            throw new Error('Not connected to a D365 environment.');
        }
        return this._authProvider.getAccessToken();
    }

    // ── Restore saved connection on workspace open ──────────────────────────

    async tryRestoreConnection(): Promise<void> {
        const stored = this.context.workspaceState.get<StoredConnection>(WORKSPACE_STATE_KEY);
        if (!stored) { return; }
        this._isRestoring = true;

        let authProvider: AuthProvider;

        if (stored.authMode === 'clientCredentials') {
            if (!stored.clientId) {
                this._isRestoring = false;
                this._onDidChangeConnection.fire(undefined);
                this.offerReconnect(stored.environmentUrl);
                return;
            }
            const secret = await this.context.secrets.get(`${SECRET_KEY_PREFIX}.${stored.environmentUrl}.${stored.clientId}`);
            if (!secret) {
                this._isRestoring = false;
                this._onDidChangeConnection.fire(undefined);
                this.offerReconnect(stored.environmentUrl);
                return;
            }
            authProvider = new ClientCredentialsProvider(stored.environmentUrl, stored.tenantId, stored.clientId, secret);
        } else {
            // silent: true — does not prompt; throws/returns undefined if no session is ready
            const userProvider = new UserAuthProvider(stored.environmentUrl);
            try {
                await userProvider.getAccessToken(true);
            } catch {
                userProvider.dispose();
                this._isRestoring = false;
                this._onDidChangeConnection.fire(undefined);
                this.offerReconnect(stored.environmentUrl);
                return;
            }
            authProvider = userProvider;
        }

        try {
            const token  = await authProvider.getAccessToken();
            const whoAmI = await this.callWhoAmI(stored.environmentUrl, token);
            this._authProvider = authProvider;
            this._connection   = { ...stored, whoAmI };
            this._isRestoring  = false;
            this._onDidChangeConnection.fire(this._connection);
        } catch {
            authProvider.dispose();
            this._isRestoring = false;
            this._onDidChangeConnection.fire(undefined);
            this.offerReconnect(stored.environmentUrl);
        }
    }

    private offerReconnect(environmentUrl: string): void {
        vscode.window.showInformationMessage(
            `D365: Previously connected to ${environmentUrl}.`,
            'Reconnect',
        ).then(choice => {
            if (choice === 'Reconnect') { void this.connect(); }
        });
    }

    // ── Interactive connect ─────────────────────────────────────────────────

    async connect(): Promise<void> {
        const config = vscode.workspace.getConfiguration('d365');

        const environmentUrl = await this.promptOrConfig(
            config.get<string>('environmentUrl'),
            { prompt: 'Dataverse environment URL', placeHolder: 'yourorg.crm11.dynamics.com' },
        );
        if (!environmentUrl) { return; }

        const authMode = await this.pickAuthMode(config.get<AuthMode>('authMode'));
        if (!authMode) { return; }

        const normalizedUrl = normalizeUrl(environmentUrl);

        let tenantId = config.get<string>('tenantId')?.trim();
        if (!tenantId) {
            try {
                tenantId = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'D365: Discovering tenant…', cancellable: false },
                    () => discoverTenantId(normalizedUrl),
                );
            } catch (err) {
                vscode.window.showErrorMessage(`Tenant discovery failed: ${errorMessage(err)}`);
                return;
            }
        }

        let clientId: string | undefined;
        if (authMode === 'clientCredentials') {
            clientId = await this.promptOrConfig(
                config.get<string>('clientId'),
                { prompt: 'Azure AD application (client) ID', placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
            );
            if (!clientId) { return; }
        }

        await this.establishConnection({ environmentUrl: normalizedUrl, tenantId, clientId, authMode });
    }

    /** Reconnects to a previously used environment (from the recent-environments list) without re-prompting for URL/tenant/auth mode. */
    async connectToStored(stored: StoredConnection): Promise<void> {
        await this.establishConnection(stored);
    }

    /** For a 'user' auth connection, prompts the Microsoft account picker so the user can switch accounts without changing environment. */
    async switchAccount(): Promise<void> {
        if (!this._connection || !(this._authProvider instanceof UserAuthProvider)) {
            vscode.window.showInformationMessage('D365: Switching accounts is only available for user sign-in connections.');
            return;
        }
        const authProvider = this._authProvider;
        const environmentUrl = this._connection.environmentUrl;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'D365: Switching account…', cancellable: false },
            async () => {
                let token: string;
                try {
                    token = await authProvider.selectAccount();
                } catch (err) {
                    vscode.window.showErrorMessage(`Sign-in failed: ${errorMessage(err)}`);
                    return;
                }

                try {
                    const whoAmI = await this.callWhoAmI(environmentUrl, token);
                    this._connection = { ...this._connection!, whoAmI };
                    this._onDidChangeConnection.fire(this._connection);
                    vscode.window.showInformationMessage('D365: Switched account.');
                } catch (err) {
                    vscode.window.showErrorMessage(`Connected but WhoAmI failed: ${errorMessage(err)}`);
                }
            },
        );
    }

    getRecentEnvironments(): StoredConnection[] {
        return this.context.globalState.get<StoredConnection[]>(RECENTS_STATE_KEY, []);
    }

    private async rememberEnvironment(stored: StoredConnection): Promise<void> {
        const isSame = (a: StoredConnection, b: StoredConnection) =>
            a.environmentUrl === b.environmentUrl && a.authMode === b.authMode && a.clientId === b.clientId;

        const updated = [stored, ...this.getRecentEnvironments().filter(r => !isSame(r, stored))].slice(0, MAX_RECENTS);
        await this.context.globalState.update(RECENTS_STATE_KEY, updated);
    }

    private async establishConnection(stored: StoredConnection): Promise<void> {
        const { environmentUrl, tenantId, clientId, authMode } = stored;
        let authProvider: AuthProvider;

        if (authMode === 'clientCredentials') {
            if (!clientId) {
                vscode.window.showErrorMessage('D365: This connection is missing its client ID.');
                return;
            }
            const clientSecret = await this.getOrPromptClientSecret(environmentUrl, clientId);
            if (!clientSecret) { return; }

            authProvider = new ClientCredentialsProvider(environmentUrl, tenantId, clientId, clientSecret);
        } else {
            authProvider = new UserAuthProvider(environmentUrl);
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'D365', cancellable: false },
            async progress => {
                progress.report({ message: `Connecting to ${environmentUrl}…` });

                let token: string;
                try {
                    // For user auth, always let the user pick which Microsoft account to use for this connection —
                    // otherwise VS Code would silently reuse whatever account was last remembered for this scope.
                    token = authProvider instanceof UserAuthProvider
                        ? await authProvider.selectAccount()
                        : await authProvider.getAccessToken();
                } catch (err) {
                    vscode.window.showErrorMessage(`Authentication failed: ${errorMessage(err)}`);
                    authProvider.dispose();
                    return;
                }

                progress.report({ message: 'Verifying connectivity…' });

                let whoAmI: WhoAmIResponse | undefined;
                try {
                    whoAmI = await this.callWhoAmI(environmentUrl, token);
                } catch (err) {
                    vscode.window.showErrorMessage(`Connected but WhoAmI failed: ${errorMessage(err)}`);
                    authProvider.dispose();
                    return;
                }

                this._authProvider?.dispose();
                this._authProvider = authProvider;
                this._connection   = { environmentUrl, tenantId, clientId, authMode, whoAmI };
                this._onDidChangeConnection.fire(this._connection);

                await this.context.workspaceState.update(WORKSPACE_STATE_KEY, {
                    environmentUrl, tenantId, clientId, authMode,
                } satisfies StoredConnection);
                await this.rememberEnvironment({ environmentUrl, tenantId, clientId, authMode });

                vscode.window.showInformationMessage(`Connected to ${environmentUrl}`);
            },
        );
    }

    disconnect(): void {
        this._authProvider?.dispose();
        this._authProvider = undefined;
        this._connection   = undefined;
        this._onDidChangeConnection.fire(undefined);
        void this.context.workspaceState.update(WORKSPACE_STATE_KEY, undefined);
        vscode.window.showInformationMessage('Disconnected from D365 environment.');
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async pickAuthMode(configured: AuthMode | undefined): Promise<AuthMode | undefined> {
        if (configured === 'user' || configured === 'clientCredentials') { return configured; }
        const pick = await vscode.window.showQuickPick(
            [
                { label: '$(account) User account',    description: 'Sign in with your Microsoft account', value: 'user' as AuthMode },
                { label: '$(key) Client credentials',  description: 'App-only using client ID + secret',   value: 'clientCredentials' as AuthMode },
            ],
            { title: 'D365: Authentication method', placeHolder: 'How should the extension authenticate?' },
        );
        return pick?.value;
    }

    private async getOrPromptClientSecret(environmentUrl: string, clientId: string): Promise<string | undefined> {
        const secretKey = `${SECRET_KEY_PREFIX}.${environmentUrl}.${clientId}`;
        const stored = await this.context.secrets.get(secretKey);
        if (stored) { return stored; }

        const secret = await vscode.window.showInputBox({
            prompt: 'Azure AD client secret',
            password: true,
            placeHolder: 'Paste your client secret here',
        });
        if (!secret) { return undefined; }

        await this.context.secrets.store(secretKey, secret);
        return secret;
    }

    private async promptOrConfig(configured: string | undefined, opts: vscode.InputBoxOptions): Promise<string | undefined> {
        if (configured?.trim()) { return configured.trim(); }
        const value = await vscode.window.showInputBox(opts);
        return value?.trim() || undefined;
    }

    private async callWhoAmI(environmentUrl: string, token: string): Promise<WhoAmIResponse> {
        const response = await fetch(`${environmentUrl}/api/data/v9.2/WhoAmI`, {
            headers: {
                Authorization: `Bearer ${token}`,
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                Accept: 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json() as Promise<WhoAmIResponse>;
    }
}

function normalizeUrl(input: string): string {
    const trimmed = input.trim().replace(/\/$/, '');
    return trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `https://${trimmed}`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
