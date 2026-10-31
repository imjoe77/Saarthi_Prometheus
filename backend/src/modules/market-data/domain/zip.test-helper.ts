import { deflateRawSync } from 'node:zlib';

/**
 * MODULE 06b TEST FIXTURE - build small, valid ZIP archives in memory.
 *
 * Not a spec file and not production code: the importer and ZIP reader specs
 * both need archives to read, and the real ones under `data/market/raw` are the
 * object under test rather than the means of asserting on it - a test that
 * depended on the exact committed dataset could never tell a reader failure
 * from a dataset change. This builder writes the same signatures, sizes and
 * CRC-32 values that any archiver does, so the reader is asserting against the
 * format and not against a sibling helper.
 *
 * Every record field the reader reads can be overstated, which is how the
 * corruption cases (`ZIP_SIZE_MISMATCH`, `ZIP_CRC32`) are made without editing
 * bytes by hand. Fields the reader never reads (version, dates, flags) are left
 * zero - they are not part of what this module checks.
 */
export interface ZipFixtureEntrySpec {
  readonly name: string;
  readonly data: Buffer;
  /** 0 = STORED, 8 = DEFLATE, or anything else the caller wants the reader to refuse. */
  readonly method?: number;
  /** CRC-32 to record instead of the real one, to make a `ZIP_CRC32`. */
  readonly crc32?: number;
  /** Uncompressed size to record instead of the real one, to make a `ZIP_SIZE_MISMATCH`. */
  readonly uncompressedSize?: number;
  /** Compressed size to record, to make a truncated member. */
  readonly compressedSize?: number;
}

/** CRC-32 (IEEE 802.3) - must agree with the reader's own table for a fixture to pass it. */
export function crc32(data: Buffer): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let tableCache: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (tableCache !== null) {
    return tableCache;
  }
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  tableCache = table;
  return table;
}

/**
 * The bytes that sit where a compressed member's data would. Only methods 0 and
 * 8 can be produced; anything else writes the raw bytes unchanged, because an
 * unsupported method is refused by the reader before it ever tries to inflate,
 * so the fixture data only needs to exist, not to decompress.
 */
function compress(method: number, data: Buffer): Buffer {
  if (method === 0) {
    return Buffer.from(data);
  }
  if (method === 8) {
    return deflateRawSync(data);
  }
  return Buffer.from(data);
}

/**
 * One complete archive: local file headers and data, then the central directory,
 * then the end-of-central-directory record.
 */
export function buildZip(entries: readonly ZipFixtureEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const records: Array<{
    name: Buffer;
    method: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  }> = [];

  let offset = 0;
  for (const spec of entries) {
    const method = spec.method ?? 8;
    const name = Buffer.from(spec.name, 'utf8');
    const raw = compress(method, spec.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(spec.crc32 ?? crc32(spec.data), 14);
    local.writeUInt32LE(spec.compressedSize ?? raw.length, 18);
    local.writeUInt32LE(spec.uncompressedSize ?? spec.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    locals.push(local, raw);
    records.push({
      name,
      method,
      crc32: spec.crc32 ?? crc32(spec.data),
      compressedSize: spec.compressedSize ?? raw.length,
      uncompressedSize: spec.uncompressedSize ?? spec.data.length,
      localHeaderOffset: offset,
    });
    offset += local.length + raw.length;
  }

  const centralDirectory: Buffer[] = [];
  for (const record of records) {
    const header = Buffer.alloc(46 + record.name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(record.method, 10);
    header.writeUInt32LE(record.crc32, 16);
    header.writeUInt32LE(record.compressedSize, 20);
    header.writeUInt32LE(record.uncompressedSize, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt32LE(record.localHeaderOffset, 42);
    record.name.copy(header, 46);
    centralDirectory.push(header);
  }

  const centralSize = centralDirectory.reduce((total, header) => total + header.length, 0);
  const centralOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...locals, ...centralDirectory, eocd]);
}

/**
 * A valid two-member archive, for the reader's happy-path round-trip.
 *
 * The second entry exercises the directory order: the reader must return
 * members in central-directory order, which here is not the write order.
 */
export function buildDefaultZip(contents: readonly { readonly name: string; readonly data: string }[]): Buffer {
  return buildZip(
    contents.map((entry, index) => ({
      name: entry.name,
      data: Buffer.from(entry.data, 'utf8'),
      method: index === 0 ? 0 : 8,
    })),
  );
}