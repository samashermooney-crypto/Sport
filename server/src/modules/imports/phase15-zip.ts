import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  directory: boolean;
}

class ZipParseError extends Error {}

const MAX_ENTRIES = 256;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;

function requireRange(
  offset: number,
  length: number,
  total: number,
  message: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > total
  )
    throw new ZipParseError(message);
}

function readUInt16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUInt32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22) throw new ZipParseError('Not a zip archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 66_000);
    i--
  ) {
    if (readUInt32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipParseError('Zip central directory not found');
  requireRange(eocd, 22, bytes.length, 'Corrupt zip end record');
  const disk = readUInt16(view, eocd + 4);
  const centralDisk = readUInt16(view, eocd + 6);
  const diskCount = readUInt16(view, eocd + 8);
  const count = readUInt16(view, eocd + 10);
  const centralSize = readUInt32(view, eocd + 12);
  const centralStart = readUInt32(view, eocd + 16);
  const commentLength = readUInt16(view, eocd + 20);
  requireRange(eocd + 22, commentLength, bytes.length, 'Corrupt zip comment');
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskCount !== count ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralStart === 0xffffffff
  )
    throw new ZipParseError('Multi-disk and ZIP64 archives are not supported');
  if (count > MAX_ENTRIES)
    throw new ZipParseError(
      `The zip archive contains more than ${String(MAX_ENTRIES)} files`,
    );
  requireRange(
    centralStart,
    centralSize,
    eocd,
    'Corrupt zip central directory',
  );
  let offset = readUInt32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    requireRange(offset, 46, bytes.length, 'Corrupt zip central directory');
    if (readUInt32(view, offset) !== 0x02014b50)
      throw new ZipParseError('Corrupt zip central directory');
    const method = readUInt16(view, offset + 10);
    const compressedSize = readUInt32(view, offset + 20);
    const uncompressedSize = readUInt32(view, offset + 24);
    const nameLength = readUInt16(view, offset + 28);
    const extraLength = readUInt16(view, offset + 30);
    const commentLength = readUInt16(view, offset + 32);
    const localOffset = readUInt32(view, offset + 42);
    requireRange(
      offset + 46,
      nameLength + extraLength + commentLength,
      bytes.length,
      'Corrupt zip central directory',
    );
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    requireRange(localOffset, 30, bytes.length, 'Corrupt zip local header');
    if (readUInt32(view, localOffset) !== 0x04034b50)
      throw new ZipParseError('Corrupt zip local header');
    const localNameLength = readUInt16(view, localOffset + 26);
    const localExtraLength = readUInt16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(
      dataStart,
      compressedSize,
      bytes.length,
      'Corrupt zip entry data',
    );
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const directory = name.endsWith('/');
    let content: Uint8Array;
    if (directory) {
      content = new Uint8Array(0);
    } else if (method === 0) {
      if (compressedSize !== uncompressedSize)
        throw new ZipParseError('Stored zip entry has inconsistent sizes');
      content = compressed;
    } else if (method === 8) {
      try {
        content = inflateRawSync(compressed, {
          maxOutputLength: Math.min(
            uncompressedSize,
            MAX_EXPANDED_BYTES - expandedBytes,
          ),
        });
      } catch {
        throw new ZipParseError('Zip entry exceeds the expanded size limit');
      }
    } else {
      throw new ZipParseError(
        `Unsupported zip compression method ${String(method)} for ${name}`,
      );
    }
    if (content.byteLength !== uncompressedSize)
      throw new ZipParseError('Zip entry has inconsistent expanded size');
    expandedBytes += content.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES)
      throw new ZipParseError('Zip archive exceeds the expanded size limit');
    entries.push({ name, bytes: content, directory });
  }
  return entries;
}
