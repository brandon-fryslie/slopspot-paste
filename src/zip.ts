// [LAW:decomposition] A pure STORE-only ZIP archive encoder: {path,text} entries ->
// one .zip byte array. It knows NOTHING of code artifacts or conversations — generic
// substrate [LAW:carrying-cost] — so codeExport (which knows artifacts) depends on it,
// never the reverse [LAW:one-way-deps].
// [LAW:effects-at-boundaries] Pure: bytes in, bytes out, no IO, no clock, no globals
// beyond TextEncoder. The download effect (Blob + anchor click) is the page's concern.
//
// [LAW:types-are-the-program] STORE (no compression), 32-bit sizes, UTF-8 paths — a
// contract exactly as strong as the domain [FRAMING:representation]. A conversation's
// extracted source files are small text, far under the 4 GiB / ZIP64 threshold, so the
// simpler total encoder is HONEST here, not a lie about a range we never occupy.
// Compression would buy bytes we don't need to save on a handful of source files and
// cost a DEFLATE implementation's carrying cost. No dependency is pulled in: a
// STORE-only zip is a fully-specified, stable format, so the encoder is residue once
// the layout is stated.
//
// [LAW:no-silent-failure] The encoder is FAITHFUL — it writes each entry's `path`
// verbatim as UTF-8, never silently rewriting it. Making paths archive-safe (stripping
// absolute roots / traversal) is the CALLER's tree policy, not a rewrite hidden here.

// [LAW:types-are-the-program] One archive member: a path and its text bytes. Binary
// entries are not representable because the only producer (extracted source code) is
// always text — a type as strong as the domain, no `Uint8Array` content arm we'd never
// populate.
export interface ZipEntry {
  readonly path: string;
  readonly text: string;
}

// [LAW:one-source-of-truth] The CRC-32 lookup table, derived ONCE from the standard
// reflected polynomial (0xEDB88320). Every entry's checksum reads from this one table.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  // The masked index is always 0..255 and CRC_TABLE has 256 entries, so the lookup is
  // in-bounds by construction — asserted, matching the codebase's loop-index idiom.
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const encoder = new TextEncoder();

// UTF-8 filename flag (general-purpose bit 11): tells the extractor the name bytes are
// UTF-8, so non-ASCII paths decode correctly instead of as legacy code-page bytes.
const FLAG_UTF8 = 0x0800;
// A valid MS-DOS date of 1980-01-01 (year 0 << 9 | month 1 << 5 | day 1). A fixed epoch
// keeps the archive a pure function of its entries — no wall-clock leaks in, so the same
// paste always encodes byte-identically [LAW:no-ambient-temporal-coupling].
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const LOCAL_HEADER = 30; // fixed bytes before the filename in a local file header
const CENTRAL_HEADER = 46; // fixed bytes before the filename in a central-directory record
const EOCD = 22; // end-of-central-directory record size (no archive comment)

// [LAW:types-are-the-program] The precomputed shape of one entry: its UTF-8 name bytes,
// its data bytes, and their checksum — everything the two headers need, derived once so
// neither the local nor central pass recomputes it.
interface Encoded {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
}

// [LAW:effects-at-boundaries] Build one .zip from the entries. Layout: each entry's
// local header + data in order, then the central directory (one record per entry), then
// the end-of-central-directory record pointing at it. All multi-byte fields are
// little-endian, per the format.
export const zipArchive = (entries: ReadonlyArray<ZipEntry>): Uint8Array => {
  const encoded: ReadonlyArray<Encoded> = entries.map((e) => {
    const data = encoder.encode(e.text);
    return { name: encoder.encode(e.path), data, crc: crc32(data) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const e of encoded) {
    localSize += LOCAL_HEADER + e.name.length + e.data.length;
    centralSize += CENTRAL_HEADER + e.name.length;
  }

  const buf = new Uint8Array(localSize + centralSize + EOCD);
  const view = new DataView(buf.buffer);
  let pos = 0;
  const u16 = (v: number): void => {
    view.setUint16(pos, v & 0xffff, true);
    pos += 2;
  };
  const u32 = (v: number): void => {
    view.setUint32(pos, v >>> 0, true);
    pos += 4;
  };
  const raw = (b: Uint8Array): void => {
    buf.set(b, pos);
    pos += b.length;
  };

  // Local header + data for each entry; record its start offset for the central pass.
  const offsets: number[] = [];
  for (const e of encoded) {
    offsets.push(pos);
    u32(0x04034b50); // local file header signature
    u16(20); // version needed to extract (2.0)
    u16(FLAG_UTF8);
    u16(0); // compression method: 0 = store
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length); // compressed size == uncompressed size (store)
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra field length
    raw(e.name);
    raw(e.data);
  }

  // Central directory: one record per entry, pointing back at its local header.
  const centralStart = pos;
  encoded.forEach((e, i) => {
    u32(0x02014b50); // central directory header signature
    u16(20); // version made by
    u16(20); // version needed to extract
    u16(FLAG_UTF8);
    u16(0); // method: store
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra field length
    u16(0); // file comment length
    u16(0); // disk number start
    u16(0); // internal file attributes
    u32(0); // external file attributes
    u32(offsets[i]!); // relative offset of local header (i indexes the entry we pushed)
    raw(e.name);
  });

  // Capture the central directory's byte length BEFORE writing the EOCD — the EOCD
  // fields below advance `pos`, so reading `pos` at the size field would overcount by
  // the EOCD bytes already written.
  const centralSizeWritten = pos - centralStart;

  // End of central directory.
  u32(0x06054b50); // EOCD signature
  u16(0); // number of this disk
  u16(0); // disk with the start of the central directory
  u16(encoded.length); // central directory records on this disk
  u16(encoded.length); // total central directory records
  u32(centralSizeWritten); // size of the central directory
  u32(centralStart); // offset of central directory from start of archive
  u16(0); // archive comment length

  return buf;
};
