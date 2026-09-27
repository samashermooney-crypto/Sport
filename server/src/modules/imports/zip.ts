import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  directory: boolean;
}

class ZipParseError extends Error {}

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
  const count = readUInt16(view, eocd + 10);
  let offset = readUInt32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (readUInt32(view, offset) !== 0x02014b50)
      throw new ZipParseError('Corrupt zip central directory');
    const method = readUInt16(view, offset + 10);
    const compressedSize = readUInt32(view, offset + 20);
    const nameLength = readUInt16(view, offset + 28);
    const extraLength = readUInt16(view, offset + 30);
    const commentLength = readUInt16(view, offset + 32);
    const localOffset = readUInt32(view, offset + 42);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    const localNameLength = readUInt16(view, localOffset + 26);
    const localExtraLength = readUInt16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const directory = name.endsWith('/');
    let content: Uint8Array;
    if (directory) {
      content = new Uint8Array(0);
    } else if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      content = inflateRawSync(compressed);
    } else {
      throw new ZipParseError(
        `Unsupported zip compression method ${String(method)} for ${name}`,
      );
    }
    entries.push({ name, bytes: content, directory });
  }
  return entries;
}
