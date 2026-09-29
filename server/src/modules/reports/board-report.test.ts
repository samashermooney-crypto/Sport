import { PDFDocument } from 'pdf-lib';
import { expect, it } from 'vitest';

import { renderBoardSeasonSummaryPdf } from './board-report';

it('renders the board summary as a single aggregate PDF page', async () => {
  const bytes = await renderBoardSeasonSummaryPdf(
    'Northstar Youth Sports',
    [
      {
        key: 'registrations',
        label: 'Registrations · past 12 months',
        display: '348',
      },
    ],
    new Date('2026-09-28T12:00:00.000Z'),
  );
  const document = await PDFDocument.load(bytes);

  expect(document.getTitle()).toBe('Board season summary');
  expect(document.getPageCount()).toBe(1);
});
