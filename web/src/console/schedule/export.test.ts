import { describe, expect, it } from 'vitest';

import { encodeCsv, parseCsvRows, printableTableDocument } from './export';

describe('schedule exports', () => {
  it('parses UTF-8 CSV with escaped quotes, commas, and embedded newlines', () => {
    expect(
      parseCsvRows(
        '\uFEFFtitle,notes\r\n"Home, away","Line 1\n""Line 2"""\r\n',
      ),
    ).toEqual([
      ['title', 'notes'],
      ['Home, away', 'Line 1\n"Line 2"'],
    ]);
  });

  it('quotes CSV fields and neutralizes spreadsheet formulas', () => {
    expect(
      encodeCsv([
        ['Title', 'Value'],
        ['=SUM(A1:A2)', 'Lake, Field'],
      ]),
    ).toBe('Title,Value\r\n\'=SUM(A1:A2),"Lake, Field"\r\n');
  });

  it('escapes event data in a print-ready PDF document', () => {
    const html = printableTableDocument(
      '<Schedule>',
      'Division & U12',
      ['Event'],
      [['<img src=x onerror=alert(1)>']],
    );

    expect(html).toContain('&lt;Schedule&gt;');
    expect(html).toContain('Division &amp; U12');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});
