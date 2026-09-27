import { createZip } from './zip';

export interface ExportTable {
  columns: readonly { key: string; label: string; type: string }[];
  rows: readonly (readonly unknown[])[];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return value.toString();
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'object') return JSON.stringify(value);
  return '';
}

function csvCell(value: unknown): string {
  let text = cellText(value);
  let firstVisible = 0;
  while (firstVisible < text.length && text.charCodeAt(firstVisible) <= 0x20)
    firstVisible += 1;
  if ('=+@-'.includes(text[firstVisible] ?? '\u0000')) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeReportCsv(table: ExportTable): Uint8Array {
  const lines = [
    table.columns.map((column) => csvCell(column.label)).join(','),
    ...table.rows.map((row) =>
      table.columns.map((_, index) => csvCell(row[index])).join(','),
    ),
  ];
  return new TextEncoder().encode(lines.join('\r\n') + '\r\n');
}

function xmlText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint >= 0x20 &&
          codePoint <= 0x10ffff &&
          (codePoint < 0xfffe || codePoint > 0xffff))
      );
    })
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function worksheetCell(reference: string, value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value))
    return `<c r="${reference}"><v>${String(value)}</v></c>`;
  if (typeof value === 'boolean')
    return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`;
  const text = xmlText(cellText(value));
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

export function serializeReportXlsx(table: ExportTable): Uint8Array {
  const rows = [
    table.columns.map((column) => column.label),
    ...table.rows.map((row) => table.columns.map((_, index) => row[index])),
  ];
  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${String(rowIndex + 1)}">${row
          .map((cell, columnIndex) =>
            worksheetCell(
              `${columnName(columnIndex)}${String(rowIndex + 1)}`,
              cell,
            ),
          )
          .join('')}</row>`,
    )
    .join('');
  const entries = [
    {
      name: '[Content_Types].xml',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>' +
          '</workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          sheetRows +
          '</sheetData></worksheet>',
      ),
    },
  ];
  return createZip(entries);
}

export function sanitizeDownloadName(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'report';
}
