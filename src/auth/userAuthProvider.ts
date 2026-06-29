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

    dispose(): void {}
}
