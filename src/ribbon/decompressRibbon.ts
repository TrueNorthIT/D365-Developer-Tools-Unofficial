import * as zlib from 'zlib';

// RetrieveEntityRibbon's CompressedEntityXml is base64 data whose actual container format isn't
// consistently documented across sources — some decompress it as plain gzip (GZipStream), but the
// canonical Microsoft sample opens it as an OPC package (System.IO.Packaging.Package — the same
// container format as .docx/.xlsx) and reads the part named "/RibbonXml". Rather than assume one,
// sniff the magic bytes and handle whichever shows up.
export function decompressRibbonPayload(base64: string): Buffer {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length < 4) { throw new Error('Ribbon payload is empty or too short to decompress.'); }

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return zlib.gunzipSync(buffer);
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
        return extractRibbonXmlPart(buffer);
    }
    if (buffer[0] === 0x78) {
        return zlib.inflateSync(buffer);
    }

    throw new Error(`Unrecognized ribbon payload format (first bytes: 0x${buffer.subarray(0, 4).toString('hex')}).`);
}

// ── Minimal ZIP/OPC reader ────────────────────────────────────────────────────
// Just enough of the PKZIP format to enumerate every entry in the package and pull out the bytes
// of a specific one by name — no archive library needed. An OPC package like this always has
// several parts (at least "[Content_Types].xml" and "_rels/.rels" alongside the real content), so
// this can't just grab the first entry; it has to find the one actually named "RibbonXml".

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const TARGET_PART_NAME = 'ribbonxml';

interface ZipEntry {
    name: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

function extractRibbonXmlPart(buffer: Buffer): Buffer {
    const eocdOffset = findEocd(buffer);
    const entries = readCentralDirectory(buffer, eocdOffset);

    // OPC part names are URIs like "/RibbonXml"; ZIP entry names for them are typically stored
    // without the leading slash. Compare loosely so either form matches.
    const target =
        entries.find(e => normalizePartName(e.name) === TARGET_PART_NAME) ??
        entries.reduce<ZipEntry | undefined>((largest, e) => (
            !largest || e.uncompressedSize > largest.uncompressedSize ? e : largest
        ), undefined);

    if (!target) {
        throw new Error('Ribbon payload ZIP contained no entries.');
    }
    if (normalizePartName(target.name) !== TARGET_PART_NAME) {
        const names = entries.map(e => e.name).join(', ') || '(none)';
        throw new Error(`Ribbon payload ZIP has no 'RibbonXml' part; falling back to largest entry '${target.name}'. All entries: ${names}`);
    }

    return extractEntry(buffer, target);
}

function readCentralDirectory(buffer: Buffer, eocdOffset: number): ZipEntry[] {
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    let offset = buffer.readUInt32LE(eocdOffset + 16);
    const entries: ZipEntry[] = [];

    for (let i = 0; i < totalEntries; i++) {
        if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
            throw new Error(`Ribbon payload's ZIP central directory entry #${i} is malformed.`);
        }

        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

function extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
        throw new Error(`Ribbon payload's local file header for '${entry.name}' is malformed.`);
    }

    const localNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) { return Buffer.from(compressed); }
    if (entry.compressionMethod === 8) { return zlib.inflateRawSync(compressed); }
    throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) for '${entry.name}'.`);
}

function normalizePartName(name: string): string {
    // Real-world entries have been observed both as bare "RibbonXml" (matching the OPC URI used by
    // Microsoft's own Package.Open sample) and as "RibbonXml.xml" — strip both the leading slash
    // and a trailing .xml extension so either form matches.
    return name.replace(/^\/+/, '').replace(/\.xml$/i, '').toLowerCase();
}

function findEocd(buffer: Buffer): number {
    // The EOCD record is 22 bytes plus an optional comment (up to 65535 bytes) after it, so it
    // isn't always the very last 22 bytes — scan backward for the signature.
    const maxCommentLength = 0xffff;
    const searchStart = Math.max(0, buffer.length - 22 - maxCommentLength);
    for (let i = buffer.length - 22; i >= searchStart; i--) {
        if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) { return i; }
    }
    throw new Error('Ribbon payload looks like a ZIP but no End Of Central Directory record was found.');
}
