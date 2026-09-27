export function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = source.replace(/^\uFEFF/, '');

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field)
        throw new Error('The exported CSV contains an invalid quoted field.');
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('The exported CSV contains an open quote.');
  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

export function encodeCsv(rows: readonly (readonly unknown[])[]): string {
  const quote = (value: unknown): string => {
    let text =
      value == null
        ? ''
        : typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    const first = text.search(/\S/);
    if (first >= 0 && '=+-@'.includes(text[first] ?? ''))
      text = `${text.slice(0, first)}'${text.slice(first)}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

export function escapeHtml(value: unknown): string {
  const text =
    value == null
      ? ''
      : typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function replacePrintDocument(document: Document, html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  const sourceWindow = document.defaultView?.opener as unknown as
    { document?: Document } | null | undefined;
  const sourceDocument = sourceWindow?.document;
  sourceDocument
    ?.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
    .forEach((link) => {
      document.head.append(document.importNode(link, true));
    });
  sourceDocument
    ?.querySelectorAll<HTMLStyleElement>('style')
    .forEach((style) => {
      document.head.append(document.importNode(style, true));
    });
}

export function printableTableDocument(
  title: string,
  subtitle: string,
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const headerCells = headers
    .map((header) => `<th scope="col">${escapeHtml(header)}</th>`)
    .join('');
  const bodyRows = rows
    .map(
      (row) =>
        `<tr>${headers
          .map((_, index) => `<td>${escapeHtml(row[index])}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    :root { color-scheme: light; font-family: var(--font-app); color: var(--ink); }
    body { margin: var(--space-24); }
    h1 { font-family: var(--font-display); font-size: var(--font-size-22); margin: 0 0 var(--space-6); }
    p { color: var(--muted); font-size: var(--font-size-12); margin: 0 0 var(--space-18); }
    table { border-collapse: collapse; width: 100%; font-family: var(--font-app); font-size: var(--font-size-11); }
    th, td { border: 1px solid var(--line); padding: var(--space-6); text-align: left; vertical-align: top; }
    th { background: var(--canvas); }
    tr { break-inside: avoid; }
    @page { margin: 14mm; }
    @media print { body { margin: 0; } }
  </style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></body></html>`;
}
