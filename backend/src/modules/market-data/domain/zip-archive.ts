import { inflateRawSync } from 'node:zlib';

import { fatalIssue, type ValidationIssue } from './validation';

/**
 * MODULE 06b - a zero-dependency reader for the ZIP archives holding the
 * Binance `1d` klines.
 *
 * WHY NOT A LIBRARY. The project takes no new runtime dependency for Module 06b,
 * and this is the one place that would otherwise need one. The reader is small
 * because the archives are simple: all 81 files in `data/market/raw` use DEFLATE
 * (method 8), which Node has in `zlib` since forever, so the reader has to
 * *correctly* support DEFLATE, *correctly* support STORED (method 0 - the
 * trivially uncompressed case, kept because a ZIP tool defaults to it) and
 * refuse everything else with a named rule rather than a mystery.
 *
 * The central directory is the source of truth for sizes and offsets, not the
 * local header. That is deliberate: a ZIP may use a data descriptor and leave the
 * local header's sizes at zero, and trusting the local header is the classic way
 * to read the first bytes of a file and think the file is four bytes long.
 *
 * WHAT IS CHECKED. Signatures, bounds, sizes, and CRC-32 of every extracted
 * member. A truncated or bit-rotted archive is a realistic failure for a dataset
 * copied between machines, and a CRC mismatch reported as `ZIP_CRC32` names the
 * file that needs re-downloading. A badly formed archive reports `ZIP_FORMAT` -
 * never an exception, because the importer's contract is findings, not throws.
 */

/** Signatures are read little-endian, so these are byte sequences in file order. */
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;

const MAX_COMMENT_LENGTH = 0xffff;
const EOCD_MINIMUM_LENGTH = 22;

export class ZipFormatError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = 'ZipFormatError';
    this.rule = rule;
  }
}

export interface ZipEntry {
  readonly name: string;
  /** 0 = STORED, 8 = DEFLATE. Anything else is a fatal `ZIP_METHOD`. */
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  /** The member's bytes, decompressed. */
  readonly data: Buffer;
}

interface CentralDirectoryRecord {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3), the checksum the ZIP format itself uses. */
function crc32(data: Buffer): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt32LE(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new ZipFormatError('ZIP_FORMAT', 'a field points past the end of the archive');
  }
  return buffer.readUInt32LE(offset);
}

function readUInt16LE(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw new ZipFormatError('ZIP_FORMAT', 'a field points past the end of the archive');
  }
  return buffer.readUInt16LE(offset);
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - EOCD_MINIMUM_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = archive.length - EOCD_MINIMUM_LENGTH; offset >= earliest; offset -= 1) {
    if (readUInt32LE(archive, offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipFormatError('ZIP_FORMAT', 'no end-of-central-directory record was found');
}

function readCentralDirectory(archive: Buffer): CentralDirectoryRecord[] {
  const eocdOffset = findEndOfCentralDirectory(archive);

  if (
    eocdOffset >= 20 &&
    readUInt32LE(archive, eocdOffset - 20) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
  ) {
    throw new ZipFormatError('ZIP64_UNSUPPORTED', 'ZIP64 archives are not supported');
  }

  const entryCount = readUInt16LE(archive, eocdOffset + 10);
  const directorySize = readUInt32LE(archive, eocdOffset + 12);
  const directoryOffset = readUInt32LE(archive, eocdOffset + 16);

  if (directoryOffset + directorySize > archive.length) {
    throw new ZipFormatError('ZIP_FORMAT', 'the central directory points past the end of the archive');
  }

  const records: CentralDirectoryRecord[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32LE(archive, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipFormatError('ZIP_FORMAT', `central directory entry ${index} has no signature`);
    }

    const compressedSize = readUInt32LE(archive, offset + 20);
    const uncompressedSize = readUInt32LE(archive, offset + 24);
    const nameLength = readUInt16LE(archive, offset + 28);
    const extraLength = readUInt16LE(archive, offset + 30);
    const commentLength = readUInt16LE(archive, offset + 32);
    const start = offset + 46;
    const end = start + nameLength;
    if (end > archive.length) {
      throw new ZipFormatError('ZIP_FORMAT', `central directory entry ${index} has a truncated name`);
    }

    records.push({
      name: archive.subarray(start, end).toString('utf8'),
      compressionMethod: readUInt16LE(archive, offset + 10),
      compressedSize,
      uncompressedSize,
      crc32: readUInt32LE(archive, offset + 16),
      localHeaderOffset: readUInt32LE(archive, offset + 42),
    });

    offset = end + extraLength + commentLength;
  }

  return records;
}

function extractMember(archive: Buffer, record: CentralDirectoryRecord): Buffer {
  const headerOffset = record.localHeaderOffset;
  if (readUInt32LE(archive, headerOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipFormatError('ZIP_FORMAT', `${record.name} has no local file header`);
  }

  const nameLength = readUInt16LE(archive, headerOffset + 26);
  const extraLength = readUInt16LE(archive, headerOffset + 28);
  const dataOffset = headerOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + record.compressedSize;
  if (dataEnd > archive.length) {
    throw new ZipFormatError('ZIP_TRUNCATED', `${record.name} is truncated`);
  }

  const compressed = archive.subarray(dataOffset, dataEnd);

  switch (record.compressionMethod) {
    case 0:
      return Buffer.from(compressed);
    case 8: {
      try {
        return inflateRawSync(compressed);
      } catch {
        throw new ZipFormatError('ZIP_DEFLATE_FAILED', `${record.name} could not be decompressed`);
      }
    }
    default:
      throw new ZipFormatError(
        'ZIP_METHOD_UNSUPPORTED',
        `${record.name} uses compression method ${record.compressionMethod}, which is neither STORED (0) nor DEFLATE (8)`,
      );
  }
}

/**
 * Read every member of one archive, in central-directory order.
 *
 * Throws `ZipFormatError` only. Callers translate that into a fatal finding
 * against the archive, which is what lets the importer keep going across 81
 * files while still refusing to write a symbol whose archive is unreadable.
 */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  if (archive.length < EOCD_MINIMUM_LENGTH) {
    throw new ZipFormatError('ZIP_FORMAT', 'the file is too short to be a ZIP archive');
  }

  const records = readCentralDirectory(archive);
  const entries: ZipEntry[] = [];

  for (const record of records) {
    const data = extractMember(archive, record);
    if (data.length !== record.uncompressedSize) {
      throw new ZipFormatError(
        'ZIP_SIZE_MISMATCH',
        `${record.name} decompressed to ${data.length} bytes, expected ${record.uncompressedSize}`,
      );
    }
    const actualCrc = crc32(data);
    if (actualCrc !== record.crc32) {
      throw new ZipFormatError(
        'ZIP_CRC32',
        `${record.name} failed its CRC-32 check (expected ${record.crc32}, got ${actualCrc})`,
      );
    }

    entries.push({
      name: record.name,
      compressionMethod: record.compressionMethod,
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
      crc32: record.crc32,
      data,
    });
  }

  return entries;
}

/** Translate a reader failure into the finding record the importer reports. */
export function zipFailureFinding(error: unknown, source: string): ValidationIssue {
  if (error instanceof ZipFormatError) {
    return fatalIssue(error.rule, source, 0, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return fatalIssue('ZIP_UNREADABLE', source, 0, `the archive could not be read: ${message}`);
}
