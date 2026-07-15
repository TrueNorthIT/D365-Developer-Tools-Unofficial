import * as assert from 'assert';
import { resolveFluentIconDataUri } from '../../src/ribbon/fluentIcon';

describe('resolveFluentIconDataUri', () => {
    it('resolves a known ModernImage name to its extracted svg data uri', () => {
        const result = resolveFluentIconDataUri('New');
        assert.ok(result?.startsWith('data:image/svg+xml;base64,'), `expected an svg data uri, got ${result}`);
        const svg = Buffer.from(result!.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
        assert.match(svg, /<svg[\s>]/);
    });

    it('resolves multiple ModernImage names that map to the same underlying icon', () => {
        // "Delete", "Remove", "Clear" and "DiscardArticle" all render Dynamics' "Delete" icon.
        const del = resolveFluentIconDataUri('Delete');
        const remove = resolveFluentIconDataUri('Remove');
        assert.ok(del);
        assert.strictEqual(del, remove);
    });

    it('returns undefined for a name with no extracted mapping', () => {
        assert.strictEqual(resolveFluentIconDataUri('ThisIsNotARealIconName123'), undefined);
    });

    it('returns undefined for an empty or blank name', () => {
        assert.strictEqual(resolveFluentIconDataUri(''), undefined);
        assert.strictEqual(resolveFluentIconDataUri('   '), undefined);
    });
});
