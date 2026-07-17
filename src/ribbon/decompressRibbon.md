# Ribbon payload format & decompression

`decompressRibbon.ts` turns the raw payload returned by Dataverse's `RetrieveEntityRibbon` action
into a plain buffer of ribbon XML bytes. This doc explains what that payload actually looks like and
how `decompressRibbonPayload` gets XML back out of it — the surrounding pipeline (fetching it, then
decoding/parsing the XML) lives in `dataverseClient.ts` and `ribbonXmlParser.ts`, referenced below for
context but not documented in depth here.

## Where the payload comes from

`DataverseClient.getEntityRibbonXml` (`dataverseClient.ts`) calls the Web API action
`RetrieveEntityRibbon(EntityName='...',RibbonLocationFilter=...)`, whose JSON response has one field
that matters here:

```json
{ "CompressedEntityXml": "<base64 string>" }
```

`CompressedEntityXml` is a base64-encoded blob. Once base64-decoded, its *container* format is not
consistently documented — Microsoft's own samples and third-party write-ups disagree, and real
environments have been observed returning more than one shape. Rather than assume a single format,
`decompressRibbonPayload` sniffs the first few bytes and dispatches accordingly.

## The three formats `decompressRibbonPayload` recognizes

| First byte(s) | Format | Handling |
|---|---|---|
| `1F 8B` | gzip (`GZipStream` on the .NET side) | `zlib.gunzipSync` |
| `50 4B` (`PK`) | ZIP / OPC package | Minimal in-house ZIP reader (see below) — the same container format Word/Excel files (`.docx`/`.xlsx`) use, per `System.IO.Packaging.Package` |
| `78` | Raw zlib/deflate stream | `zlib.inflateSync` |

Anything else throws, including the first 4 bytes (as hex) in the error message so a genuinely new
format can be identified from a bug report without needing a repro environment.

If the buffer is under 4 bytes, it throws immediately rather than attempting to sniff — there's
nothing meaningful to distinguish at that size.

## The ZIP/OPC case, in detail

This is the shape the canonical Microsoft sample code (`Package.Open` over the decoded bytes) expects,
and the one that needs real parsing rather than a single `zlib` call. An OPC package is a ZIP archive
with a handful of small "parts" — expect to see at least `[Content_Types].xml` and `_rels/.rels`
alongside the actual ribbon content, so the code can't just grab the ZIP's first or only entry; it has
to find the specific part holding the ribbon XML.

`decompressRibbon.ts` implements just enough of the PKZIP format to do that, with no archive library
dependency:

1. **Find the End Of Central Directory (EOCD) record** (`findEocd`). Its signature (`PK\x05\x06`,
   i.e. `0x06054b50` little-endian) is fixed-size (22 bytes) but can be followed by up to 64 KiB of
   trailing comment, so it isn't always the literal last 22 bytes of the file — this scans backward
   from the end until the signature is found.
2. **Read the central directory** (`readCentralDirectory`). The EOCD record gives the entry count and
   the central directory's start offset; each entry (signature `PK\x01\x02`) yields the part's name,
   compression method, compressed/uncompressed sizes, and — critically — the offset of its *local*
   file header, since the actual bytes live there, not in the central directory itself.
3. **Pick the target entry** (`extractRibbonXmlPart`). OPC part names are URIs like `/RibbonXml`; ZIP
   entry names for the same part have been observed both as bare `RibbonXml` and as `RibbonXml.xml`
   (`normalizePartName` strips a leading slash and a trailing `.xml` case-insensitively so either form
   matches). If no entry normalizes to `ribbonxml`, this doesn't guess silently — it throws, naming
   every entry actually found in the package, though the error message does note which entry (the
   largest by uncompressed size) it *would* have fallen back to, as a debugging hint.
4. **Extract that entry's bytes** (`extractEntry`). Reads the local file header at the offset found in
   step 2 (signature `PK\x03\x04`) to locate where the actual data starts (past the header, name, and
   any extra field), then decompresses it according to its own compression method: `0` (stored, i.e.
   already uncompressed) is returned as-is; `8` (deflate) goes through `zlib.inflateRawSync` (raw,
   headerless deflate — distinct from the `zlib`/gzip formats handled elsewhere in this file, which
   both carry their own header/trailer). Any other compression method throws rather than silently
   returning garbage.

## What comes out, and what happens next

`decompressRibbonPayload` returns a `Buffer` of **raw ribbon XML bytes** — not yet decoded to a
string, and not yet parsed. Two things happen after this module hands back that buffer, both in
`dataverseClient.ts`:

- **Text decoding** (`decodeXmlBuffer`, private to `dataverseClient.ts`): ribbon XML exports aren't
  guaranteed to be UTF-8 — CRM's ribbon tooling frequently emits UTF-16 — so this sniffs the buffer's
  leading bytes for a BOM (`FF FE` little-endian, `FE FF` big-endian, or the UTF-8 BOM `EF BB BF`) and
  decodes accordingly, falling back to plain UTF-8 if none is present.
- **Parsing** (`parseRibbonXml`, `ribbonXmlParser.ts`): the decoded XML string is then parsed into this
  extension's plain `RibbonModel` shape (tabs → groups → controls, command definitions, rules) for the
  ribbon editor to render and edit.

```
RetrieveEntityRibbon (Web API)
  -> CompressedEntityXml (base64)
  -> decompressRibbonPayload (this file): base64-decode, sniff container format, decompress
  -> Buffer of raw XML bytes
  -> decodeXmlBuffer (dataverseClient.ts): BOM-aware decode to a string
  -> parseRibbonXml (ribbonXmlParser.ts): string -> RibbonModel
```
