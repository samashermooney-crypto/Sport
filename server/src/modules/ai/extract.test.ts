import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ExtractError, extractText } from './extract';

function makeZip(entries: { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

describe('AI document text extraction', () => {
  it('trims text and markdown and caps extracted content', () => {
    expect(
      extractText('notes.MD', new TextEncoder().encode('  season\n ')),
    ).toBe('season');
    expect(
      extractText('large.txt', new TextEncoder().encode('x'.repeat(50_001))),
    ).toHaveLength(50_000);
  });

  it('extracts PDF text operators from plain and deflated streams', () => {
    const plainContent = Buffer.from(
      String.raw`BT (Spring \(2026\)) Tj ET BT [(Club ) -120 (season)] TJ ET`,
      'latin1',
    );
    const pdf = (stream: Buffer) =>
      Buffer.concat([
        Buffer.from('%PDF-1.7\nstream\n', 'latin1'),
        stream,
        Buffer.from('\nendstream\n%%EOF', 'latin1'),
      ]);

    expect(extractText('schedule.pdf', pdf(plainContent))).toBe(
      'Spring (2026)\nClub season',
    );
    expect(
      extractText(
        'compressed.pdf',
        pdf(deflateSync(Buffer.from('BT (Summer) Tj ET', 'latin1'))),
      ),
    ).toBe('Summer');
  });

  it('reads paragraphs from DOCX and rejects unsupported or empty documents', () => {
    const archive = makeZip([
      {
        name: 'word/document.xml',
        bytes: new TextEncoder().encode(
          '<w:document><w:body><w:p><w:r><w:t>Practice</w:t><w:t> schedule</w:t></w:r></w:p><w:p><w:r><w:t>Fall 2026</w:t></w:r></w:p></w:body></w:document>',
        ),
      },
    ]);
    expect(extractText('notes.DOCX', archive)).toBe(
      'Practice schedule\nFall 2026',
    );
    expect(() => extractText('legacy.doc', archive)).toThrow(
      'Only .docx Word files are supported',
    );
    expect(() => extractText('broken.docx', new Uint8Array([1, 2, 3]))).toThrow(
      ExtractError,
    );
    expect(() => extractText('empty.pdf', new Uint8Array())).toThrow(
      'No readable text found',
    );
    expect(() => extractText('photo.png', new Uint8Array([1]))).toThrow(
      'Unsupported file type',
    );
    expect(() =>
      extractText(
        'missing-document.docx',
        makeZip([{ name: 'other.xml', bytes: new Uint8Array() }]),
      ),
    ).toThrow('DOCX has no document.xml');
  });
});
