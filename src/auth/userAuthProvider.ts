import * as vscode from 'vscode';
import type { AuthProvider } from './authProvider';

/**
 * Delegates to VS Code's built-in Microsoft auth provider.
 * Handles token caching and silent refresh automatically.
 * The user signs in once via their VS Code Microsoft account.
 */
export class UserAuthProvider implements AuthProvider {
    private readonly scope: string;

    constructor(environmentUrl: string) {
        // Dataverse resource scope — e.g. https://yourorg.crm11.dynamics.com/.default
        this.scope = `${environmentUrl}/.default`;
    }

    /**
     * `silent: true` quietly restores a saved connection on startup — no prompt, fails if no session is ready.
     * Otherwise reuses whichever account is already remembered for this scope, prompting only if none exists yet.
     * Called on every Dataverse request, so it must never force the account picker — use {@link selectAccount} for that.
     */
    async getAccessToken(silent = false): Promise<string> {
        const session = await vscode.authentication.getSession(
            'microsoft',
            [this.scope],
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
            [this.scope],
            { createIfNone: true, clearSessionPreference: true },
        );
        if (!session) {
            throw new Error('No Microsoft authentication session available.');
        }
        return session.accessToken;
    }

    dispose(): void {}
}
