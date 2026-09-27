import type { ImportKind } from '@shared/schemas/imports';

import { importFields } from './fields';

const SAMPLES: Partial<Record<ImportKind, string[][]>> = {
  people: [
    [
      'Alex',
      'Rivera',
      'alex.rivera@example.test',
      '555-0134',
      'guardian',
      '',
      'Jordan',
      'Rivera',
      'player',
      '2016-03-12',
      '2026 Spring Soccer',
      'U10',
      'U10 North',
      'Avery Rivera',
      '555-0100',
      'Imported contact',
      'no',
    ],
  ],
  registrations: [
    [
      'Alex',
      'Rivera',
      'alex.rivera@example.test',
      'guardian',
      'Jordan',
      'Rivera',
      'player',
      '2016-03-12',
      '2025 Fall Soccer',
      'U10',
      'U10 North',
      '149.00',
      'paid',
      '2025-08-15',
      'Old system #1042',
      'no',
      '',
      '',
    ],
  ],
  teams: [
    [
      'Falcons',
      'U10 North',
      '',
      'Sam',
      'Coach',
      'sam.coach@example.test',
      '555-0187',
      'head_coach',
      '2',
    ],
  ],
  rosters: [
    [
      'Falcons',
      '2026 Spring Soccer',
      'Jordan',
      'Rivera',
      'alex.rivera@example.test',
      '2016-03-12',
      '12',
      'active',
      '',
      '',
    ],
  ],
  schedule: [
    [
      'Falcons vs Wolves',
      'Falcons',
      'Wolves',
      'game',
      'U10 North',
      '2026-04-11',
      '2026-04-11',
      '2026-04-11',
      '15:00',
      '16:00',
      'Field 1',
      'Riverside Park',
      '203 River Rd',
      'Denver',
      'CO',
      '80205',
      '',
    ],
  ],
  facilities: [
    [
      'Field 1',
      'field',
      'Riverside Park',
      '203 River Rd',
      'Denver',
      'CO',
      '80205',
      'outdoor',
      '',
      '',
      '',
      'no',
    ],
  ],
  credentials: [
    [
      'Alex',
      'Rivera',
      'alex.rivera@example.test',
      'Background Check',
      'clear',
      '2026-09-01',
      'Sterling',
      'alex_rivera_background_check.pdf',
      '',
      '',
      '',
    ],
  ],
  historical_payments: [
    [
      'Alex',
      'Rivera',
      'alex.rivera@example.test',
      '149.00',
      '2025-08-15',
      '2025 Fall Soccer registration',
      'card',
      'paid',
      'Old system #1042',
    ],
  ],
  volunteer_hours: [
    [
      'Alex',
      'Rivera',
      'alex.rivera@example.test',
      'Field marshal',
      'Opening day',
      '2026-03-14',
      '3.5',
      'approved',
      'Set up and managed field marshal station',
    ],
  ],
};

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function renderTemplate(kind: ImportKind): string {
  const header = importFields[kind].map((field) => field.label);
  const rows = SAMPLES[kind] ?? [];
  return [header, ...rows]
    .map((line) => line.map(csvEscape).join(','))
    .join('\n')
    .concat('\n');
}
