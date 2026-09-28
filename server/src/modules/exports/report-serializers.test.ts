import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  sanitizeDownloadName,
  serializeReportCsv,
  serializeReportXlsx,
} from './report-serializers';

function zipEntries(archive: Uint8Array): Map<string, string> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const entries = new Map<string, string>();
  let offset = 0;
  while (
    offset + 30 <= archive.length &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    const compressedLength = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = new TextDecoder().decode(
      archive.subarray(nameStart, nameStart + fileNameLength),
    );
    const content = inflateRawSync(
      archive.subarray(dataStart, dataStart + compressedLength),
    ).toString('utf8');
    entries.set(name, content);
    offset = dataStart + compressedLength;
  }
  return entries;
}

describe('report export serialization', () => {
  it('neutralizes spreadsheet formulas in CSV cells', () => {
    const csv = new TextDecoder().decode(
      serializeReportCsv({
        columns: [{ key: 'name', label: 'Name', type: 'text' }],
        rows: [['=HYPERLINK("https://example.test")']],
      }),
    );

    expect(csv).toBe('"Name"\r\n"\'=HYPERLINK(""https://example.test"")"\r\n');
  });

  it('writes strings as inline XLSX cells so user values are never formulas', () => {
    const entries = zipEntries(
      serializeReportXlsx({
        columns: [{ key: 'label', label: 'Label', type: 'text' }],
        rows: [['=1+1'], ['<athlete & family>']],
      }),
    );
    const sheet = entries.get('xl/worksheets/sheet1.xml');

    expect(sheet).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">=1+1</t>',
    );
    expect(sheet).toContain('&lt;athlete &amp; family&gt;');
    expect(sheet).not.toContain('<f>');
  });

  it('normalizes download filenames and falls back when empty', () => {
    expect(sanitizeDownloadName('Q3 / Receivables')).toBe('Q3-Receivables');
    expect(sanitizeDownloadName('///')).toBe('report');
  });
});
