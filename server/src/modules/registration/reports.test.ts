import { describe, expect, it } from 'vitest';

import { registrationReportCsv, registrationReportSchema } from './reports.js';

describe('registration report CSV', () => {
  it('quotes cells and neutralizes spreadsheet formulas', () => {
    const report = registrationReportSchema.parse({
      filters: {},
      total: 1,
      truncated: false,
      registrations: [
        {
          registrationId: '0199a413-a221-7000-8000-000000000011',
          participantName: '=1+1,Family',
          programId: '0199a413-a221-7000-8000-000000000012',
          programName: 'Fall "Soccer"',
          divisionId: null,
          divisionName: null,
          offeringId: '0199a413-a221-7000-8000-000000000013',
          offeringName: 'Youth',
          teamName: null,
          status: 'confirmed',
          registeredAt: '2026-09-27T12:00:00.000Z',
        },
      ],
    });

    const csv = registrationReportCsv(report);
    expect(csv).toContain('"\'=1+1,Family"');
    expect(csv).toContain('"Fall ""Soccer"""');
  });
});
