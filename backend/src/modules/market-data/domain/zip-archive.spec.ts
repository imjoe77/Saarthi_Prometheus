import { buildDefaultZip, buildZip, crc32 } from './zip.test-helper';
import { ZipFormatError, readZipEntries, zipFailureFinding } from './zip-archive';

/**
 * MODULE 06b - the zero-dependency ZIP reader.
 *
 * The whole fixture strategy exists for this file: a ZIP that the reader itself
 * was used to inspect would prove nothing, so every archive here is written by
 * `zip.test-helper`, which emits the format from first principles. The happy
 * paths confirm the reader trusts the central directory (sizes, order, methods);
 * the corruption paths confirm each failure has its own rule.
 */
function readAsFailure(archive: Buffer): ZipFormatError {
  let error: unknown;
  try {
    readZipEntries(archive);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(ZipFormatError);
  return error as ZipFormatError;
}

describe('readZipEntries', () => {
  it('reads STORED and DEFLATE members and returns them in directory order', () => {
    const archive = buildDefaultZip([
      { name: 'first.csv', data: 'a\nb\n' },
      { name: 'second.csv', data: 'x\ny\nz\n' },
    ]);

    const entries = readZipEntries(archive);

    expect(entries.map((entry) => entry.name)).toEqual(['first.csv', 'second.csv']);
    expect(entries[0]?.compressionMethod).toBe(0);
    expect(entries[0]?.data.toString('utf8')).toBe('a\nb\n');
    expect(entries[1]?.compressionMethod).toBe(8);
    expect(entries[1]?.data.toString('utf8')).toBe('x\ny\nz\n');
    expect(entries[1]?.uncompressedSize).toBe(6);
  });

  it('reports the real compressed size of a DEFLATE member', () => {
    const archive = buildDefaultZip([{ name: 'one.csv', data: 'row\n' }]);

    const [entry] = readZipEntries(archive);

    expect(entry?.compressedSize ?? 0).toBeLessThan((entry?.uncompressedSize ?? 0) + 1);
    expect(entry?.uncompressedSize).toBe(4);
  });

  it('verifies the CRC-32 of every member', () => {
    const entries = readZipEntries(buildDefaultZip([{ name: 'a.csv', data: 'content\n' }]));

    expect(entries[0]?.crc32).toBe(crc32(Buffer.from('content\n', 'utf8')));
  });

  it.each([
    ['a file too short to be an archive', Buffer.alloc(4)],
    ['a file with no end-of-central-directory record', Buffer.from('not a zip at all')],
  ])('refuses %s as ZIP_FORMAT', (_label, bytes) => {
    expect(readAsFailure(bytes).rule).toBe('ZIP_FORMAT');
  });

  it('refuses a ZIP64 locator as ZIP64_UNSUPPORTED', () => {
    const archive = buildDefaultZip([{ name: 'a.csv', data: 'row\n' }]);

    // The locator sits 20 bytes before the end-of-central-directory signature,
    // which is exactly where the reader looks for it.
    const tampered = Buffer.from(archive);
    tampered.writeUInt32LE(0x07064b50, archive.length - 22 - 20);

    expect(readAsFailure(tampered).rule).toBe('ZIP64_UNSUPPORTED');
  });

  it('refuses a member whose recorded size does not match its data as ZIP_SIZE_MISMATCH', () => {
    const archive = buildZip([
      { name: 'a.csv', data: Buffer.from('short\n', 'utf8'), method: 0, uncompressedSize: 99 },
    ]);

    expect(readAsFailure(archive).rule).toBe('ZIP_SIZE_MISMATCH');
  });

  it('refuses a member whose data fails its recorded CRC-32 as ZIP_CRC32', () => {
    const archive = buildZip([
      { name: 'a.csv', data: Buffer.from('name one thing\n', 'utf8'), method: 8, crc32: 0 },
    ]);

    expect(readAsFailure(archive).rule).toBe('ZIP_CRC32');
  });

  it('refuses a member that extends past the end of the archive as ZIP_TRUNCATED', () => {
    const archive = buildZip([
      { name: 'a.csv', data: Buffer.from('content here\n', 'utf8'), method: 0, compressedSize: 1000 },
    ]);

    expect(readAsFailure(archive).rule).toBe('ZIP_TRUNCATED');
  });

  it('refuses a member that cannot be inflated as ZIP_DEFLATE_FAILED', () => {
    // A raw DEFLATE block reads its length checks from the first bytes, so a
    // member that claims method 8 while starting with a stored-block header
    // that contradicts itself cannot inflate - deterministically.
    const garbage = Buffer.concat([Buffer.from([0x00]), Buffer.from('this will never inflate\n')]);
    const archive = buildZip([{ name: 'a.csv', data: garbage, method: 0 }]);

    // The central directory's method field is what the reader trusts.
    const directoryOffset = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt16LE(8, directoryOffset + 10);

    expect(readAsFailure(archive).rule).toBe('ZIP_DEFLATE_FAILED');
  });

  it('refuses an unknown compression method as ZIP_METHOD_UNSUPPORTED', () => {
    const archive = buildZip([{ name: 'a.csv', data: Buffer.from('x\n', 'utf8'), method: 99 }]);

    const error = readAsFailure(archive);
    expect(error.rule).toBe('ZIP_METHOD_UNSUPPORTED');
    expect(error.message).toContain('99');
  });

  it('refuses a directory that points past the end of the archive as ZIP_FORMAT', () => {
    const archive = buildDefaultZip([{ name: 'a.csv', data: 'ok\n' }]);

    // The directory size field is barely read; lying about it must be refused
    // rather than parsed into out-of-bounds reads.
    const tampered = Buffer.from(archive);
    tampered.writeUInt32LE(0xffffffff, archive.length - 22 + 12);

    expect(readAsFailure(tampered).rule).toBe('ZIP_FORMAT');
  });

  it('maps a reader failure to a fatal finding carrying its rule', () => {
    const finding = zipFailureFinding(
      new ZipFormatError('ZIP_TRUNCATED', 'a.zip is truncated'),
      'symbols/BTCUSDT/a.zip',
    );

    expect(finding.severity).toBe('fatal');
    expect(finding.rule).toBe('ZIP_TRUNCATED');
    expect(finding.source).toBe('symbols/BTCUSDT/a.zip');
    expect(finding.line).toBe(0);
  });

  it('maps a non-reader failure to ZIP_UNREADABLE', () => {
    const finding = zipFailureFinding(new Error('disk gone'), 'symbols/BTCUSDT/a.zip');

    expect(finding.rule).toBe('ZIP_UNREADABLE');
    expect(finding.message).toContain('disk gone');
  });
});