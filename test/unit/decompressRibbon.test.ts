import * as assert from 'assert';
import * as zlib from 'zlib';
import { decompressRibbonPayload } from '../../src/ribbon/decompressRibbon';
import { buildZip } from '../helpers/zip';

describe('decompressRibbonPayload', () => {
    const xml = '<RibbonDefinitions><RibbonXml><Tabs/></RibbonXml></RibbonDefinitions>';

    it('decompresses a plain gzip payload', () => {
        const base64 = zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
        const result = decompressRibbonPayload(base64);
        assert.strictEqual(result.toString('utf8'), xml);
    });

    it('decompresses a raw zlib-wrapped payload', () => {
        const base64 = zlib.deflateSync(Buffer.from(xml, 'utf8')).toString('base64');
        const result = decompressRibbonPayload(base64);
        assert.strictEqual(result.toString('utf8'), xml);
    });

    it('extracts a stored (uncompressed) "RibbonXml" part from a single-entry ZIP/OPC container', () => {
        const zip = buildZip([{ name: 'RibbonXml', content: Buffer.from(xml, 'utf8'), method: 0 }]);
        const result = decompressRibbonPayload(zip.toString('base64'));
        assert.strictEqual(result.toString('utf8'), xml);
    });

    it('extracts a deflated "RibbonXml" part from a single-entry ZIP/OPC container', () => {
        const zip = buildZip([{ name: 'RibbonXml', content: Buffer.from(xml, 'utf8'), method: 8 }]);
        const result = decompressRibbonPayload(zip.toString('base64'));
        assert.strictEqual(result.toString('utf8'), xml);
    });

    it('finds the "RibbonXml" part by name in a real multi-part OPC package, not just the first entry', () => {
        // A real OPC package always has other parts before the actual content — conventionally
        // "[Content_Types].xml" first. Regression test for grabbing the first ZIP entry blindly.
        const zip = buildZip([
            { name: '[Content_Types].xml', content: Buffer.from('<Types xmlns="urn:opc"/>', 'utf8'), method: 0 },
            { name: '_rels/.rels', content: Buffer.from('<Relationships/>', 'utf8'), method: 0 },
            { name: 'RibbonXml', content: Buffer.from(xml, 'utf8'), method: 8 },
        ]);
        const result = decompressRibbonPayload(zip.toString('base64'));
        assert.strictEqual(result.toString('utf8'), xml);
    });

    it('matches a "RibbonXml.xml" entry name too (the form Dataverse actually returns)', () => {
        const zip = buildZip([
            { name: 'RibbonXml.xml', content: Buffer.from(xml, 'utf8'), method: 8 },
            { name: '[Content_Types].xml', content: Buffer.from('<Types xmlns="urn:opc"/>', 'utf8'), method: 0 },
        ]);
        const result = decompressRibbonPayload(zip.toString('base64'));
        assert.strictEqual(result.toString('utf8'), xml);
    });

    it('throws a descriptive error listing entry names when no "RibbonXml" part exists', () => {
        const zip = buildZip([
            { name: '[Content_Types].xml', content: Buffer.from('<Types xmlns="urn:opc"/>', 'utf8'), method: 0 },
            { name: 'SomethingElse', content: Buffer.from('not the ribbon', 'utf8'), method: 0 },
        ]);
        assert.throws(
            () => decompressRibbonPayload(zip.toString('base64')),
            /no 'RibbonXml' part.*\[Content_Types\]\.xml, SomethingElse/,
        );
    });

    it('throws a descriptive error for an unrecognized format', () => {
        const base64 = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');
        assert.throws(() => decompressRibbonPayload(base64), /Unrecognized ribbon payload format/);
    });
});
