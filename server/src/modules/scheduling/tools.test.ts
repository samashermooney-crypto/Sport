import { describe, expect, it } from 'vitest';

import type { OrgContext } from '../../db/withOrg';

import {
  createScheduleImport,
  decodeScheduleImportFile,
  exportScheduleCsv,
  normalizeScheduleImportInstant,
  shiftGamesOnDate,
} from './tools';

const context: OrgContext = {
  orgId: '00000000-0000-4000-8000-000000000001',
  actor: { accountId: '00000000-0000-4000-8000-000000000002' },
};

describe('schedule import formats and local times', () => {
  it('reads UTF-8 BOM and auto-detects Windows-1252 CSV', () => {
    const utf8 = new TextEncoder().encode(
      '\uFEFFtitle,kind,timezone\nGame,game,America/Chicago',
    );
    expect(decodeScheduleImportFile(utf8, 'schedule.csv')).toContain('Game');

    const windows1252 = new Uint8Array([
      0x74, 0x69, 0x74, 0x6c, 0x65, 0x2c, 0x6b, 0x69, 0x6e, 0x64, 0x2c, 0x74,
      0x69, 0x6d, 0x65, 0x7a, 0x6f, 0x6e, 0x65, 0x0a, 0x47, 0x61, 0x6d, 0x65,
      0x92, 0x73, 0x2c, 0x67, 0x61, 0x6d, 0x65, 0x2c, 0x55, 0x54, 0x43,
    ]);
    expect(decodeScheduleImportFile(windows1252, 'schedule.csv')).toContain(
      'Game’s',
    );
  });

  it('rejects non-CSV import files', () => {
    expect(() =>
      decodeScheduleImportFile(new Uint8Array([0, 1, 2]), 'schedule.xlsx'),
    ).toThrow(/choose a \.csv file/i);
  });

  it('accepts the documented date forms and rejects ambiguous DD/MM dates', () => {
    for (const date of [
      '2026-04-03',
      '4/3/2026',
      '04/03/2026',
      '04-03-2026',
      '46115',
    ]) {
      expect(
        normalizeScheduleImportInstant('', date, '10:30', 'America/Phoenix'),
      ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(() =>
      normalizeScheduleImportInstant('', '13/04/2026', '10:30', 'UTC'),
    ).toThrow(/DD\/MM\/YYYY/);
  });

  it('resolves a spring-forward gap using compatible local-time rules', () => {
    expect(
      normalizeScheduleImportInstant(
        '',
        '2026-03-08',
        '02:30',
        'America/Chicago',
      ),
    ).toBe('2026-03-08T08:30:00Z');
    expect(
      normalizeScheduleImportInstant(
        '',
        '2026-03-08',
        '02:30',
        'America/Phoenix',
      ),
    ).toBe('2026-03-08T09:30:00Z');
  });

  it('rejects invalid export ranges before querying tenant data', async () => {
    await expect(
      exportScheduleCsv(
        context,
        { type: 'program', id: '00000000-0000-4000-8000-000000000003' },
        {
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2026-01-01T00:00:00.000Z'),
        },
      ),
    ).rejects.toThrow('The export date range must be at most 370 days.');
  });

  it('rejects invalid import files before queueing work', async () => {
    await expect(
      createScheduleImport(context, new Uint8Array(), 'schedule.csv'),
    ).rejects.toThrow('Imports must be between 1 byte and 20 MB.');
    await expect(
      createScheduleImport(
        context,
        new TextEncoder().encode('event'),
        'schedule.xlsx',
      ),
    ).rejects.toThrow('Choose a .csv file.');
  });

  it('rejects a zero-day bulk shift before loading games', async () => {
    await expect(
      shiftGamesOnDate(context, {
        fromDate: '2026-10-10',
        toDate: '2026-10-10',
        timezone: 'UTC',
      }),
    ).rejects.toThrow('Choose a different date within 370 days.');
  });
});
