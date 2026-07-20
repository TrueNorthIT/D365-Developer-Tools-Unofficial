import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscodeMock from '../mocks/vscode';
import { UserAuthProvider } from '../../src/auth/userAuthProvider';

const ENV_URL = 'https://contoso.crm.dynamics.com';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const EXPECTED_SCOPES = [`${ENV_URL}/.default`, `VSCODE_TENANT:${TENANT_ID}`];

describe('UserAuthProvider', () => {
    afterEach(() => {
        sinon.restore();
        vscodeMock.resetVscodeMock();
    });

    describe('getAccessToken', () => {
        it('calls vscode.authentication.getSession with createIfNone: true by default and returns the accessToken', async () => {
            const stub = sinon.stub(vscodeMock.authentication, 'getSession')
                .resolves({ accessToken: 'token-1' } as any);

            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);
            const token = await provider.getAccessToken();

            assert.strictEqual(token, 'token-1');
            sinon.assert.calledOnceWithExactly(
                stub,
                'microsoft',
                EXPECTED_SCOPES,
                { createIfNone: true },
            );
        });

        it('calls vscode.authentication.getSession with silent: true when silent=true', async () => {
            const stub = sinon.stub(vscodeMock.authentication, 'getSession')
                .resolves({ accessToken: 'token-2' } as any);

            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);
            const token = await provider.getAccessToken(true);

            assert.strictEqual(token, 'token-2');
            sinon.assert.calledOnce(stub);
            const [service, scopes, options] = stub.getCall(0).args;
            assert.strictEqual(service, 'microsoft');
            assert.deepStrictEqual(scopes, EXPECTED_SCOPES);
            assert.deepStrictEqual(options, { silent: true });
        });

        it('throws when getSession resolves to undefined (default, non-silent)', async () => {
            sinon.stub(vscodeMock.authentication, 'getSession').resolves(undefined);

            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);

            await assert.rejects(
                () => provider.getAccessToken(),
                /No Microsoft authentication session available\./,
            );
        });

        it('throws when getSession resolves to undefined (silent)', async () => {
            sinon.stub(vscodeMock.authentication, 'getSession').resolves(undefined);

            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);

            await assert.rejects(
                () => provider.getAccessToken(true),
                /No Microsoft authentication session available\./,
            );
        });
    });

    describe('selectAccount', () => {
        it('calls getSession with createIfNone and clearSessionPreference, and returns the accessToken', async () => {
            const stub = sinon.stub(vscodeMock.authentication, 'getSession')
                .resolves({ accessToken: 'token-3' } as any);

            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);
            const token = await provider.selectAccount();

            assert.strictEqual(token, 'token-3');
            sinon.assert.calledOnceWithExactly(
                stub,
                'microsoft',
                EXPECTED_SCOPES,
                { createIfNone: true, clearSessionPreference: true },
            );
        });

        it('throws the same error message when no session is available', async () => {
            sinon.stub(vscodeMock.authentication, 'getSession').resolves(undefined);

            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);

            await assert.rejects(
                () => provider.selectAccount(),
                /No Microsoft authentication session available\./,
            );
        });
    });

    describe('dispose', () => {
        it('does not throw', () => {
            const provider = new UserAuthProvider(ENV_URL, TENANT_ID);
            assert.doesNotThrow(() => provider.dispose());
        });
    });
});
