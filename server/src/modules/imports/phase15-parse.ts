import ExcelJS from 'exceljs';

const IMPORT_MAX_ROWS = 20_000;
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export class ImportParseError extends Error {}

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

function decodeText(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  pushRow();
  return rows.filter(
    (cells, index) =>
      index === 0 || cells.some((cell) => cell.trim().length > 0),
  );
}

function cellsToTable(cells: string[][]): ParsedTable {
  if (cells.length === 0) throw new ImportParseError('The file is empty');
  const headers = (cells[0] ?? []).map((header) => header.trim());
  if (headers.every((header) => header.length === 0))
    throw new ImportParseError('The header row is empty');
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header.toLowerCase()))
      throw new ImportParseError(`Duplicate column header "${header}"`);
    seen.add(header.toLowerCase());
  }
  const rows: Record<string, string>[] = [];
  for (const line of cells.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (line[index] ?? '').trim();
    });
    rows.push(record);
  }
  if (rows.length > IMPORT_MAX_ROWS)
    throw new ImportParseError(
      `The file has ${String(rows.length)} rows; the limit is ${String(IMPORT_MAX_ROWS)}`,
    );
  return { headers, rows };
}

export function parseCsv(bytes: Uint8Array): ParsedTable {
  return cellsToTable(parseCsvText(decodeText(bytes)));
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedTable> {
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(bytes) as unknown as Parameters<
    typeof workbook.xlsx.load
  >[0];
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ImportParseError('The workbook has no sheets');
  const cells: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const line: string[] = [];
    const values = row.values as (ExcelJS.CellValue | undefined)[];
    for (let index = 1; index <= row.cellCount; index += 1) {
      const value = values[index];
      if (value === null || value === undefined) line.push('');
      else if (value instanceof Date) line.push(value.toISOString());
      else if (typeof value === 'object' && 'richText' in value)
        line.push(value.richText.map((part) => part.text).join(''));
      else if (typeof value === 'object' && 'text' in value)
        line.push(value.text);
      else if (typeof value === 'object' && 'result' in value) {
        const result = value.result;
        line.push(
          result instanceof Date
            ? result.toISOString()
            : typeof result === 'string' ||
                typeof result === 'number' ||
                typeof result === 'boolean'
              ? String(result)
              : '',
        );
      } else if (value instanceof Error) line.push('');
      else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )
        line.push(String(value));
      else line.push('');
    }
    cells.push(line);
  });
  return cellsToTable(cells);
}

export async function parseImportFile(
  fileName: string,
  bytes: Uint8Array,
): Promise<ParsedTable> {
  if (bytes.byteLength > IMPORT_MAX_BYTES)
    throw new ImportParseError('The file exceeds the 20 MB limit');
  if (/\.xlsx$/i.test(fileName)) return parseXlsx(bytes);
  return parseCsv(bytes);
}
