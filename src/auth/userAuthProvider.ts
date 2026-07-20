import * as vscode from 'vscode';
import type { AuthProvider } from './authProvider';

/**
 * Delegates to VS Code's built-in Microsoft auth provider.
 * Handles token caching and silent refresh automatically.
 * The user signs in once via their VS Code Microsoft account.
 */
export class UserAuthProvider implements AuthProvider {
    private readonly scopes: string[];

    constructor(environmentUrl: string, tenantId: string) {
        // Dataverse resource scope — e.g. https://yourorg.crm11.dynamics.com/.default
        // The `VSCODE_TENANT:` pseudo-scope tells VS Code's Microsoft provider to acquire the
        // token against this specific tenant's authority rather than the default organizations/
        // common endpoint (which resolves to the user's HOME tenant). This is essential for guest
        // (B2B) accounts: without it the token carries the guest's home tenant identity, so Dataverse
        // in the resource tenant doesn't recognise the guest's security roles and denies table access.
        this.scopes = [`${environmentUrl}/.default`, `VSCODE_TENANT:${tenantId}`];
    }

    /**
     * `silent: true` quietly restores a saved connection on startup — no prompt, fails if no session is ready.
     * Otherwise reuses whichever account is already remembered for this scope, prompting only if none exists yet.
     * Called on every Dataverse request, so it must never force the account picker — use {@link selectAccount} for that.
     */
    async getAccessToken(silent = false): Promise<string> {
        const session = await vscode.authentication.getSession(
            'microsoft',
            this.scopes,
            silent ? { silent: true } : { createIfNone: true },
        );
        if (!session) {
            throw new Error('No Microsoft authentication session available.');
        }
        return session.accessToken;
    }

    /**
     * Forces the Microsoft account picker, forgetting whichever account was previously remembered for this scope.
     * Intended for one-off, explicit user actions (establishing a new connection, "Switch Account") — never for
     * routine token refreshes, since those must stay silent.
     */
    async selectAccount(): Promise<string> {
        const session = await vscode.authentication.getSession(
            'microsoft',
            this.scopes,
            { createIfNone: true, clearSessionPreference: true },
        );
        if (!session) {
            throw new Error('No Microsoft authentication session available.');
        }
        return session.accessToken;
    }

    dispose(): void {}
}
