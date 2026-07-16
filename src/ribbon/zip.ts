import * as zlib from 'zlib';

// Hand-builds a minimal ZIP (PKZIP) buffer with one or more entries, matching the OPC package
// ("System.IO.Packaging.Package" — the same container format as .docx/.xlsx) that Dataverse solution
// packages use. No archive library dependency -- correctness (CRC32 + local/central headers + EOCD)
// matters here since a malformed zip would fail ImportSolution, but the format itself is small and
// well-specified enough not to need one. Originally written for ribbon-response test fixtures
// (test/helpers/zip.ts re-exports this) and reused as-is for building solution packages
// (solutionPackage.ts) -- same format, same correctness requirements either way.
export function buildZip(files: Array<{ name: string; content: Buffer; method: 0 | 8 }>): Buffer {
    const localEntries: Buffer[] = [];
    const centralEntries: Buffer[] = [];
    const localOffsets: number[] = [];
    let runningOffset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.name, 'utf8');
        const data = file.method === 8 ? zlib.deflateRawSync(file.content) : file.content;
        const crc = crc32(file.content);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4); // version needed
        localHeader.writeUInt16LE(0, 6); // flags
        localHeader.writeUInt16LE(file.method, 8);
        localHeader.writeUInt16LE(0, 10); // mod time
        localHeader.writeUInt16LE(0, 12); // mod date
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(file.content.length, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28); // extra length

        const localEntry = Buffer.concat([localHeader, nameBuf, data]);
        localOffsets.push(runningOffset);
        localEntries.push(localEntry);
        runningOffset += localEntry.length;

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4); // version made by
        centralHeader.writeUInt16LE(20, 6); // version needed
        centralHeader.writeUInt16LE(0, 8); // flags
        centralHeader.writeUInt16LE(file.method, 10);
        centralHeader.writeUInt16LE(0, 12);
        centralHeader.writeUInt16LE(0, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(file.content.length, 24);
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(0, 30); // extra length
        centralHeader.writeUInt16LE(0, 32); // comment length
        centralHeader.writeUInt16LE(0, 34); // disk number
        centralHeader.writeUInt16LE(0, 36); // internal attrs
        centralHeader.writeUInt32LE(0, 38); // external attrs
        // local header offset patched in below, once all local entries are laid out
        centralHeader.writeUInt32LE(0, 42);
        centralEntries.push(Buffer.concat([centralHeader, nameBuf]));
    }

    // Patch each central directory entry's local header offset now that we know final positions.
    for (let i = 0; i < centralEntries.length; i++) {
        centralEntries[i].writeUInt32LE(localOffsets[i], 42);
    }

    const localSection = Buffer.concat(localEntries);
    const centralSection = Buffer.concat(centralEntries);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralSection.length, 12);
    eocd.writeUInt32LE(localSection.length, 16); // central dir starts right after all local entries
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([localSection, centralSection, eocd]);
}

// Standard CRC-32 (zip uses this); a real implementation is required since some readers validate it.
function crc32(buf: Buffer): number {
    let crc = ~0;
    for (const byte of buf) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (~crc) >>> 0;
}
