import * as assert from 'assert';
import { RibbonLabelCache } from '../../src/ribbonLabelCache';

function makeContext() {
    const globalStateStore = new Map<string, unknown>();
    return {
        globalState: {
            get: <T>(key: string, def?: T) => (globalStateStore.has(key) ? globalStateStore.get(key) : def) as T,
            update: async (key: string, value: unknown) => { globalStateStore.set(key, value); },
        },
    } as unknown as import('vscode').ExtensionContext;
}

describe('RibbonLabelCache', () => {
    it('returns an empty object for an environment that has never been cached', () => {
        const cache = new RibbonLabelCache(makeContext());
        assert.deepStrictEqual(cache.get('https://contoso.crm.dynamics.com'), {});
    });

    it('stores and retrieves labels for a given environment', async () => {
        const cache = new RibbonLabelCache(makeContext());
        await cache.merge('https://contoso.crm.dynamics.com', { 'new.account.mybutton.button.LabelText': 'My Button' });

        assert.deepStrictEqual(
            cache.get('https://contoso.crm.dynamics.com'),
            { 'new.account.mybutton.button.LabelText': 'My Button' },
        );
    });

    it('merges a later publish\'s labels with earlier ones instead of replacing the whole set', async () => {
        const cache = new RibbonLabelCache(makeContext());
        await cache.merge('https://contoso.crm.dynamics.com', { 'id1.LabelText': 'First' });
        await cache.merge('https://contoso.crm.dynamics.com', { 'id2.LabelText': 'Second' });

        assert.deepStrictEqual(
            cache.get('https://contoso.crm.dynamics.com'),
            { 'id1.LabelText': 'First', 'id2.LabelText': 'Second' },
        );
    });

    it('overwrites just the entry for a re-published Id, leaving other entries untouched', async () => {
        const cache = new RibbonLabelCache(makeContext());
        await cache.merge('https://contoso.crm.dynamics.com', { 'id1.LabelText': 'Old Text', 'id2.LabelText': 'Untouched' });
        await cache.merge('https://contoso.crm.dynamics.com', { 'id1.LabelText': 'New Text' });

        assert.deepStrictEqual(
            cache.get('https://contoso.crm.dynamics.com'),
            { 'id1.LabelText': 'New Text', 'id2.LabelText': 'Untouched' },
        );
    });

    it('keeps caches for different environments independent', async () => {
        const cache = new RibbonLabelCache(makeContext());
        await cache.merge('https://a.crm.dynamics.com', { 'id1.LabelText': 'A' });
        await cache.merge('https://b.crm.dynamics.com', { 'id1.LabelText': 'B' });

        assert.deepStrictEqual(cache.get('https://a.crm.dynamics.com'), { 'id1.LabelText': 'A' });
        assert.deepStrictEqual(cache.get('https://b.crm.dynamics.com'), { 'id1.LabelText': 'B' });
    });

    it('does not write to globalState at all for an empty label set', async () => {
        const context = makeContext();
        const updateSpy = context.globalState.update as unknown as (...args: unknown[]) => Promise<void>;
        let callCount = 0;
        context.globalState.update = async (...args: Parameters<typeof updateSpy>) => { callCount++; return updateSpy(...args); };

        const cache = new RibbonLabelCache(context);
        await cache.merge('https://contoso.crm.dynamics.com', {});

        assert.strictEqual(callCount, 0);
    });
});
