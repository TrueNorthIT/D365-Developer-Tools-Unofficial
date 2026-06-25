/**
 * Discovers the Azure AD tenant ID for a Dataverse environment by making an
 * unauthenticated request and parsing the WWW-Authenticate challenge header.
 *
 * Example header value:
 *   Bearer authorization_uri="https://login.microsoftonline.com/<tenantId>/oauth2/authorize", ...
 */
export async function discoverTenantId(environmentUrl: string): Promise<string> {
    const response = await fetch(`${environmentUrl}/api/data/v9.2/`, {
        headers: { Accept: 'application/json' },
    });

    // A healthy Dataverse endpoint returns 401 for unauthenticated requests.
    if (response.status !== 401) {
        throw new Error(
            `Unexpected response from ${environmentUrl} (HTTP ${response.status}). ` +
            `Check the environment URL is correct and reachable.`,
        );
    }

    const wwwAuth = response.headers.get('WWW-Authenticate');
    if (!wwwAuth) {
        throw new Error('No WWW-Authenticate header in response — cannot discover tenant ID.');
    }

    // The header contains: authorization_uri="https://login.microsoftonline.com/<tenantId>/oauth2/..."
    const match = wwwAuth.match(
        /authorization_uri=["']?https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\//i,
    );
    if (!match) {
        throw new Error(`Could not parse tenant ID from WWW-Authenticate header: ${wwwAuth}`);
    }

    return match[1];
}
