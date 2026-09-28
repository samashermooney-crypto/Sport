import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createZip, crc32 } from './zip';

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('ZIP archive writer', () => {
  it('uses the standard CRC-32 checksum', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes an extractable UTF-8 entry and central directory', () => {
    const contents = new TextEncoder().encode('Athlentry reports');
    const archive = createZip([{ name: 'reports/season.txt', data: contents }]);
    const archiveView = view(archive);
    expect(archiveView.getUint32(0, true)).toBe(0x04034b50);
    expect(archiveView.getUint32(archive.length - 22, true)).toBe(0x06054b50);
    expect(archiveView.getUint16(archive.length - 12, true)).toBe(1);

    const nameLength = archiveView.getUint16(26, true);
    const compressedLength = archiveView.getUint32(18, true);
    const compressedStart = 30 + nameLength;
    const inflated = inflateRawSync(
      archive.subarray(compressedStart, compressedStart + compressedLength),
    );
    expect(inflated.equals(Buffer.from(contents))).toBe(true);
  });

  it.each(['../private.csv', '/absolute.csv', 'reports/../private.csv'])(
    'rejects unsafe archive entry names: %s',
    (name) => {
      expect(() => createZip([{ name, data: new Uint8Array() }])).toThrow(
        'Unsafe ZIP entry name',
      );
    },
  );
});
