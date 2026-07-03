import * as assert from 'assert';
import * as sinon from 'sinon';
import { ConfidentialClientApplication, type AuthenticationResult } from '@azure/msal-node';
import { ClientCredentialsProvider } from '../../src/auth/clientCredentialsProvider';

describe('ClientCredentialsProvider', () => {
    afterEach(() => {
        sinon.restore();
    });

    function makeProvider(): ClientCredentialsProvider {
        return new ClientCredentialsProvider(
            'https://contoso.crm.dynamics.com',
            'tenant-id',
            'client-id',
            'client-secret',
        );
    }

    it('resolves getAccessToken() with the accessToken from a successful MSAL response', async () => {
        sinon.stub(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential')
            .resolves({ accessToken: 'abc123' } as AuthenticationResult);

        const provider = makeProvider();
        const token = await provider.getAccessToken();

        assert.strictEqual(token, 'abc123');
    });

    it('calls acquireTokenByClientCredential with the correct scope', async () => {
        const stub = sinon.stub(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential')
            .resolves({ accessToken: 'abc123' } as AuthenticationResult);

        const provider = makeProvider();
        await provider.getAccessToken();

        sinon.assert.calledOnceWithExactly(stub, {
            scopes: ['https://contodso.crm.dynamics.com/.default'],
        });
    });

    it('throws a clear error when MSAL returns null', async () => {
        sinon.stub(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential')
            .resolves(null);

        const provider = makeProvider();

        await assert.rejects(
            () => provider.getAccessToken(),
            /Failed to acquire access token from Azure AD\./,
        );
    });

    it('throws a clear error when MSAL returns an object with no accessToken', async () => {
        sinon.stub(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential')
            .resolves({} as AuthenticationResult);

        const provider = makeProvider();

        await assert.rejects(
            () => provider.getAccessToken(),
            /Failed to acquire access token from Azure AD\./,
        );
    });

    it('dispose() does not throw and returns void', () => {
        const provider = makeProvider();
        const result = provider.dispose();
        assert.strictEqual(result, undefined);
    });
});
