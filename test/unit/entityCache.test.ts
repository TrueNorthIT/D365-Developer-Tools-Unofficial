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

    describe('solution entity ids', () => {
        it('returns undefined for a solution that has never been cached', () => {
            const cache = new EntityCache(makeContext());
            assert.strictEqual(cache.getSolutionEntityIds('https://contoso.crm.dynamics.com', 's1'), undefined);
        });

        it('stores and retrieves entity ids for a given environment + solution', async () => {
            const cache = new EntityCache(makeContext());
            await cache.setSolutionEntityIds('https://contoso.crm.dynamics.com', 's1', ['e1', 'e2']);

            assert.deepStrictEqual(cache.getSolutionEntityIds('https://contoso.crm.dynamics.com', 's1'), ['e1', 'e2']);
        });

        it('overwrites a previous cache entry for the same environment + solution', async () => {
            const cache = new EntityCache(makeContext());
            await cache.setSolutionEntityIds('https://contoso.crm.dynamics.com', 's1', ['e1']);
            await cache.setSolutionEntityIds('https://contoso.crm.dynamics.com', 's1', ['e2', 'e3']);

            assert.deepStrictEqual(cache.getSolutionEntityIds('https://contoso.crm.dynamics.com', 's1'), ['e2', 'e3']);
        });

        it('keeps caches independent across environments and across solutions within the same environment', async () => {
            const cache = new EntityCache(makeContext());
            await cache.setSolutionEntityIds('https://a.crm.dynamics.com', 's1', ['a-s1']);
            await cache.setSolutionEntityIds('https://a.crm.dynamics.com', 's2', ['a-s2']);
            await cache.setSolutionEntityIds('https://b.crm.dynamics.com', 's1', ['b-s1']);

            assert.deepStrictEqual(cache.getSolutionEntityIds('https://a.crm.dynamics.com', 's1'), ['a-s1']);
            assert.deepStrictEqual(cache.getSolutionEntityIds('https://a.crm.dynamics.com', 's2'), ['a-s2']);
            assert.deepStrictEqual(cache.getSolutionEntityIds('https://b.crm.dynamics.com', 's1'), ['b-s1']);
        });
    });
});
