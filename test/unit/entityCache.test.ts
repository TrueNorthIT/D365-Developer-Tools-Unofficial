import * as assert from 'assert';
import { EntityCache } from '../../src/entityCache';
import type { EntityDefinition } from '../../src/dataverseClient';

function makeContext() {
    const globalStateStore = new Map<string, unknown>();
    return {
        globalState: {
            get: <T>(key: string, def?: T) => (globalStateStore.has(key) ? globalStateStore.get(key) : def) as T,
            update: async (key: string, value: unknown) => { globalStateStore.set(key, value); },
        },
    } as unknown as import('vscode').ExtensionContext;
}

function entity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
    return { metadataId: '1', logicalName: 'account', schemaName: 'Account', displayName: 'Account', isCustom: false, ...overrides };
}

describe('EntityCache', () => {
    it('returns undefined for an environment that has never been cached', () => {
        const cache = new EntityCache(makeContext());
        assert.strictEqual(cache.get('https://contoso.crm.dynamics.com'), undefined);
    });

    it('stores and retrieves entities for a given environment', async () => {
        const cache = new EntityCache(makeContext());
        const entities = [entity()];

        await cache.set('https://contoso.crm.dynamics.com', entities);

        assert.deepStrictEqual(cache.get('https://contoso.crm.dynamics.com'), entities);
    });

    it('overwrites a previous cache entry for the same environment', async () => {
        const cache = new EntityCache(makeContext());
        await cache.set('https://contoso.crm.dynamics.com', [entity({ logicalName: 'account' })]);
        await cache.set('https://contoso.crm.dynamics.com', [entity({ logicalName: 'contact' })]);

        const cached = cache.get('https://contoso.crm.dynamics.com');
        assert.strictEqual(cached?.length, 1);
        assert.strictEqual(cached?.[0].logicalName, 'contact');
    });

    it('keeps caches for different environments independent', async () => {
        const cache = new EntityCache(makeContext());
        await cache.set('https://a.crm.dynamics.com', [entity({ logicalName: 'account' })]);
        await cache.set('https://b.crm.dynamics.com', [entity({ logicalName: 'contact' })]);

        assert.strictEqual(cache.get('https://a.crm.dynamics.com')?.[0].logicalName, 'account');
        assert.strictEqual(cache.get('https://b.crm.dynamics.com')?.[0].logicalName, 'contact');
    });
});
