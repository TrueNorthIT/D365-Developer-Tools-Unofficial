import { ConfidentialClientApplication, type AuthenticationResult } from '@azure/msal-node';
import type { AuthProvider } from './authProvider';

/**
 * App-only authentication using Azure AD client credentials flow.
 * Use this when the extension acts as a service/daemon rather than on behalf of a user.
 */
export class ClientCredentialsProvider implements AuthProvider {
    private readonly msalApp: ConfidentialClientApplication;
    private readonly scope: string;

    constructor(
        environmentUrl: string,
        tenantId: string,
        clientId: string,
        clientSecret: string,
    ) {
        this.scope = `${environmentUrl}/.default`;

        this.msalApp = new ConfidentialClientApplication({
            auth: {
                authority: `https://login.microsoftonline.com/${tenantId}`,
                clientId,
                clientSecret,
            },
        });
    }

    async getAccessToken(): Promise<string> {
        // MSAL caches silently; first call acquires, subsequent calls return cached token
        const result: AuthenticationResult | null = await this.msalApp.acquireTokenByClientCredential({
            scopes: [this.scope],
        });

        if (!result?.accessToken) {
            throw new Error('Failed to acquire access token from Azure AD.');
        }

        return result.accessToken;
    }

    dispose(): void {}
}
