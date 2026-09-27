import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { expand } from '@shared/recurrence';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import { assertSchedulePermission } from './access';
import {
  eventRecipients,
  getConflicts,
  insertSpaceBooking,
  leafSpaceIds,
  queueChangeBatch,
  resolveTimezoneAndBuffer,
  SchedulingRuleError,
} from './events';
import { sendSchedulingJob } from './generator';
import type { EventCreateWithOverrideInput } from './schema';
import { eventCreateWithOverrideSchema } from './schema';

function escapeCsv(value: unknown): string {
  let text =
    value == null
      ? ''
      : typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  let first = 0;
  while (
    first < text.length &&
    (text.charCodeAt(first) <= 0x20 || text.charCodeAt(first) === 0x7f)
  )
    first += 1;
  if ('=+-@'.includes(text[first] ?? '')) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows: readonly (readonly unknown[])[]): string {
  return `${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`;
}

export async function exportScheduleCsv(
  context: OrgContext,
  scope: { type: 'program' | 'division' | 'team'; id: string },
  range: { from: Date; to: Date },
): Promise<string> {
  if (
    range.from >= range.to ||
    range.to.getTime() - range.from.getTime() > 370 * 86_400_000
  )
    throw new SchedulingRuleError(
      'The export date range must be at most 370 days.',
    );
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.read', {
      ...(scope.type === 'program' ? { programId: scope.id } : {}),
      ...(scope.type === 'division' ? { divisionId: scope.id } : {}),
      ...(scope.type === 'team' ? { teamSeasonId: scope.id } : {}),
    });
    let query = trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('starts_at', '<', range.to)
      .where('ends_at', '>', range.from)
      .where('status', '!=', 'canceled')
      .orderBy('starts_at')
      .limit(1000);
    if (scope.type === 'program')
      query = query.where('program_id', '=', scope.id);
    if (scope.type === 'division')
      query = query.where('division_id', '=', scope.id);
    let rows = await query.execute();
    if (scope.type === 'team') {
      const refs = await trx
        .selectFrom('event_participants')
        .select('event_id')
        .where('org_id', '=', context.orgId)
        .where('team_season_id', '=', scope.id)
        .execute();
      const ids = new Set(refs.map((row) => row.event_id));
      rows = rows.filter((event) => ids.has(event.id));
    }
    const eventIds = rows.map((event) => event.id);
    const participants = eventIds.length
      ? await trx
          .selectFrom('event_participants')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('event_id', 'in', eventIds)
          .execute()
      : [];
    const homeIds = [
      ...new Set(
        participants.flatMap((row) =>
          row.side === 'home' && row.team_season_id ? [row.team_season_id] : [],
        ),
      ),
    ];
    const awayIds = [
      ...new Set(
        participants.flatMap((row) =>
          row.side === 'away' && row.team_season_id ? [row.team_season_id] : [],
        ),
      ),
    ];
    const teamIds = [...new Set([...homeIds, ...awayIds])];
    const teamRows = teamIds.length
      ? await trx
          .selectFrom('team_seasons')
          .innerJoin('teams', (join) =>
            join
              .onRef('teams.org_id', '=', 'team_seasons.org_id')
              .onRef('teams.id', '=', 'team_seasons.team_id'),
          )
          .select([
            'team_seasons.id',
            'team_seasons.display_name',
            'teams.name',
          ])
          .where('team_seasons.org_id', '=', context.orgId)
          .where('team_seasons.id', 'in', teamIds)
          .execute()
      : [];
    const teamNames = new Map(
      teamRows.map((team) => [team.id, team.display_name ?? team.name]),
    );
    const facilities = rows.flatMap((event) =>
      event.space_id ? [event.space_id] : [],
    );
    const spaces = facilities.length
      ? await trx
          .selectFrom('spaces')
          .select(['id', 'name', 'facility_id'])
          .where('org_id', '=', context.orgId)
          .where('id', 'in', facilities)
          .execute()
      : [];
    const spaceById = new Map(spaces.map((space) => [space.id, space]));
    const header = [
      'event_id',
      'title',
      'kind',
      'starts_at',
      'ends_at',
      'timezone',
      'status',
      'space_id',
      'space_name',
      'location_text',
      'home_team_season_id',
      'home_team',
      'away_team_season_id',
      'away_team',
      'division_id',
      'program_id',
      'override_reason',
    ];
    return csv([
      header,
      ...rows.map((event) => {
        const refs = participants.filter((row) => row.event_id === event.id);
        const home =
          refs.find((row) => row.side === 'home' && row.team_season_id)
            ?.team_season_id ?? '';
        const away =
          refs.find((row) => row.side === 'away' && row.team_season_id)
            ?.team_season_id ?? '';
        return [
          event.id,
          event.title,
          event.kind,
          event.starts_at.toISOString(),
          event.ends_at.toISOString(),
          event.timezone,
          event.status,
          event.space_id,
          event.space_id ? spaceById.get(event.space_id)?.name : '',
          event.location_text,
          home,
          teamNames.get(home) ?? '',
          away,
          teamNames.get(away) ?? '',
          event.division_id,
          event.program_id,
          '',
        ];
      }),
    ]);
  });
}

type CsvImportRow = {
  title: string;
  kind: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  program_id: string;
  division_id: string;
  space_id: string;
  location_text: string;
  home_team_season_id: string;
  away_team_season_id: string;
  override_reason: string;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') {
      if (field)
        throw new SchedulingRuleError(
          'A CSV quote must begin at the start of a field.',
        );
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted)
    throw new SchedulingRuleError('The CSV has an unfinished quoted field.');
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (!rows.length)
    throw new SchedulingRuleError('The CSV contains no schedule rows.');
  return rows;
}

const importHeaders = ['title', 'kind', 'timezone'] as const;
const optionalImportHeaders = [
  'starts_at',
  'ends_at',
  'start_date',
  'end_date',
  'start_time',
  'end_time',
  'program_id',
  'division_id',
  'space_id',
  'location_text',
  'home_team_season_id',
  'away_team_season_id',
  'override_reason',
] as const;

function importDate(value: string): Temporal.PlainDate {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    if (serial < 1 || serial > 2_958_466)
      throw new SchedulingRuleError(
        `Invalid numeric date serial “${trimmed}”.`,
      );
    const days = Math.floor(serial);
    return Temporal.PlainDate.from('1899-12-30').add({ days });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
    return Temporal.PlainDate.from(trimmed);
  const match = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(trimmed);
  if (!match)
    throw new SchedulingRuleError(
      `Invalid date “${trimmed}”. Use YYYY-MM-DD, M/D/YYYY, or MM-DD-YYYY.`,
    );
  const first = Number(match[1]);
  const second = Number(match[3]);
  if (first > 12 && second <= 12)
    throw new SchedulingRuleError(
      `Date “${trimmed}” looks like DD/MM/YYYY. Use M/D/YYYY or YYYY-MM-DD.`,
    );
  const month = match[2] === '-' ? first : first;
  const day = second;
  if (match[2] === '/' && first > 12)
    throw new SchedulingRuleError(
      `Date “${trimmed}” looks like DD/MM/YYYY. Use M/D/YYYY or YYYY-MM-DD.`,
    );
  return Temporal.PlainDate.from({ year: Number(match[4]), month, day });
}

function importTime(value: string): Temporal.PlainTime {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const fraction = Number(trimmed) % 1;
    const totalSeconds = Math.round(fraction * 86_400) % 86_400;
    return Temporal.PlainTime.from({
      hour: Math.floor(totalSeconds / 3600),
      minute: Math.floor((totalSeconds % 3600) / 60),
      second: totalSeconds % 60,
    });
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match)
    throw new SchedulingRuleError(
      `Invalid time “${trimmed}”. Use 24-hour HH:MM or HH:MM:SS.`,
    );
  return Temporal.PlainTime.from({
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: Number(match[3] ?? 0),
  });
}

function importInstant(
  value: string,
  dateValue: string,
  timeValue: string,
  timezone: string,
): string {
  const raw = value.trim();
  if (raw && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw))
    return new Date(raw).toISOString();
  if (
    raw &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(raw)
  ) {
    return Temporal.PlainDateTime.from(raw)
      .toZonedDateTime(timezone, { disambiguation: 'compatible' })
      .toInstant()
      .toString();
  }
  const date = importDate(dateValue || raw);
  if (!timeValue)
    throw new SchedulingRuleError(
      `A local start/end time is required for date “${date.toString()}”. Add start_time and end_time columns.`,
    );
  return date
    .toPlainDateTime(importTime(timeValue))
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString();
}

export function normalizeScheduleImportInstant(
  value: string,
  dateValue: string,
  timeValue: string,
  timezone: string,
): string {
  return importInstant(value, dateValue, timeValue, timezone);
}

function csvTextFromFile(file: Uint8Array, filename: string): string {
  if (file.byteLength > 20 * 1024 * 1024)
    throw new SchedulingRuleError('Imports are limited to 20 MB.');
  if (!/\.csv$/i.test(filename))
    throw new SchedulingRuleError('Choose a .csv file.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    try {
      return new TextDecoder('windows-1252', { fatal: true }).decode(file);
    } catch {
      throw new SchedulingRuleError(
        'The CSV encoding is not supported. Save it as UTF-8 or Windows-1252.',
      );
    }
  }
}

export function decodeScheduleImportFile(
  file: Uint8Array,
  filename: string,
): string {
  return csvTextFromFile(file, filename);
}

export async function importScheduleFile(
  context: OrgContext,
  file: Uint8Array,
  filename: string,
  commit: boolean,
) {
  return importScheduleCsv(context, csvTextFromFile(file, filename), commit);
}

export const scheduleImportJob = 'scheduling.validate-import';

export async function createScheduleImport(
  context: OrgContext,
  file: Uint8Array,
  filename: string,
): Promise<string> {
  if (file.byteLength < 1 || file.byteLength > 20 * 1024 * 1024)
    throw new SchedulingRuleError('Imports must be between 1 byte and 20 MB.');
  const fileName = filename.trim().slice(0, 255);
  if (!/\.csv$/i.test(fileName))
    throw new SchedulingRuleError('Choose a .csv file.');
  const id = newId();
  await withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    await trx
      .insertInto('schedule_import_runs')
      .values({
        id,
        org_id: context.orgId,
        created_by: context.actor.accountId,
        file_name: fileName,
        source: Buffer.from(file),
        status: 'queued',
        progress: 0,
        version: 1,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.import.create',
      entityType: 'schedule_import_run',
      entityId: id,
      changes: { fileName: { tier: 'internal', after: fileName } },
    });
  });
  try {
    await sendSchedulingJob(scheduleImportJob, {
      orgId: context.orgId,
      runId: id,
    });
  } catch {
    await withOrg(context, async (trx) => {
      await trx
        .updateTable('schedule_import_runs')
        .set({
          status: 'failed',
          error_message: 'The schedule worker could not be reached.',
          source: null,
          completed_at: new Date(),
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', id)
        .execute();
    });
    throw new SchedulingRuleError(
      'The schedule import worker is unavailable right now.',
      503,
      'DEPENDENCY_UNAVAILABLE',
    );
  }
  return id;
}

export async function runScheduleImport(
  data: unknown,
): Promise<{ runId: string; status: string }> {
  const job = data as { orgId?: unknown; runId?: unknown };
  if (typeof job.orgId !== 'string' || typeof job.runId !== 'string')
    throw new RangeError('Invalid schedule import job');
  const { orgId, runId } = job;
  const input = await withOrg(
    { orgId, actor: { accountId: newId() } },
    async (trx) => {
      const run = await trx
        .selectFrom('schedule_import_runs')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!run || run.status !== 'queued' || !run.source) return null;
      await trx
        .updateTable('schedule_import_runs')
        .set({
          status: 'running',
          progress: 10,
          version: run.version + 1,
          error_message: null,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', runId)
        .execute();
      await sql`select pg_notify('schedule_import_progress', ${JSON.stringify({ orgId, runId, status: 'running', progress: 10 })})`.execute(
        trx,
      );
      return {
        createdBy: run.created_by,
        fileName: run.file_name,
        source: run.source,
      };
    },
  );
  if (!input) return { runId, status: 'skipped' };
  const context: OrgContext = { orgId, actor: { accountId: input.createdBy } };
  try {
    const result = await importScheduleFile(
      context,
      input.source,
      input.fileName,
      false,
    );
    const invalid = result.rows.some((row) => row.errors.length > 0);
    await withOrg(context, async (trx) => {
      await trx
        .updateTable('schedule_import_runs')
        .set({
          status: invalid ? 'invalid' : 'ready',
          progress: 100,
          result: result as unknown as Json,
          source: invalid ? null : input.source,
          completed_at: invalid ? new Date() : null,
          version: sql`version + 1`,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', runId)
        .where('status', '=', 'running')
        .execute();
      await sql`select pg_notify('schedule_import_progress', ${JSON.stringify({ orgId, runId, status: invalid ? 'invalid' : 'ready', progress: 100 })})`.execute(
        trx,
      );
    });
    return { runId, status: invalid ? 'invalid' : 'ready' };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'The uploaded schedule file could not be validated.';
    await withOrg(context, async (trx) => {
      await trx
        .updateTable('schedule_import_runs')
        .set({
          status: 'failed',
          progress: 100,
          source: null,
          error_message: message.slice(0, 1000),
          completed_at: new Date(),
          version: sql`version + 1`,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', runId)
        .where('status', '=', 'running')
        .execute();
      await sql`select pg_notify('schedule_import_progress', ${JSON.stringify({ orgId, runId, status: 'failed', progress: 100 })})`.execute(
        trx,
      );
    });
    return { runId, status: 'failed' };
  }
}

export async function getScheduleImport(context: OrgContext, runId: string) {
  return withOrg(context, async (trx) => {
    const run = await trx
      .selectFrom('schedule_import_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run)
      throw new SchedulingRuleError(
        'Schedule import not found.',
        404,
        'NOT_FOUND',
      );
    await assertSchedulePermission(trx, context, 'schedule.manage');
    return {
      id: run.id,
      fileName: run.file_name,
      status: run.status,
      progress: run.progress,
      result: run.result,
      errorMessage: run.error_message,
      version: run.version,
    };
  });
}

export async function commitScheduleImport(
  context: OrgContext,
  runId: string,
  expectedVersion: number,
) {
  const run = await withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const row = await trx
      .selectFrom('schedule_import_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!row)
      throw new SchedulingRuleError(
        'Schedule import not found.',
        404,
        'NOT_FOUND',
      );
    if (row.version !== expectedVersion) throw new VersionConflictError(row);
    if (row.status !== 'ready' || !row.source)
      throw new SchedulingRuleError(
        'Only a validated import can be committed.',
        409,
        'CONFLICT',
      );
    const updated = await trx
      .updateTable('schedule_import_runs')
      .set({ status: 'committing', version: row.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(row);
    return { source: updated.source as Buffer, fileName: updated.file_name };
  });
  try {
    const result = await importScheduleFile(
      context,
      run.source,
      run.fileName,
      true,
    );
    if (!result.committed) {
      await withOrg(context, async (trx) => {
        await trx
          .updateTable('schedule_import_runs')
          .set({
            status: 'invalid',
            result: result as unknown as Json,
            source: null,
            completed_at: new Date(),
            version: sql`version + 1`,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', runId)
          .where('status', '=', 'committing')
          .execute();
      });
      return { ...result, status: 'invalid' };
    }
    await withOrg(context, async (trx) => {
      await trx
        .updateTable('schedule_import_runs')
        .set({
          status: 'committed',
          result: result as unknown as Json,
          source: null,
          completed_at: new Date(),
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', runId)
        .where('status', '=', 'committing')
        .execute();
      await appendAuditEvent(trx, context, {
        action: 'schedule.import.commit',
        entityType: 'schedule_import_run',
        entityId: runId,
        changes: { eventCount: { tier: 'internal', after: result.imported } },
      });
    });
    return { ...result, status: 'committed' };
  } catch (error) {
    await withOrg(context, async (trx) => {
      await trx
        .updateTable('schedule_import_runs')
        .set({
          status: 'ready',
          error_message:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : 'Import could not be committed.',
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', runId)
        .where('status', '=', 'committing')
        .execute();
    });
    throw error;
  }
}

export async function discardScheduleImport(
  context: OrgContext,
  runId: string,
  expectedVersion: number,
): Promise<void> {
  await withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const run = await trx
      .selectFrom('schedule_import_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run)
      throw new SchedulingRuleError(
        'Schedule import not found.',
        404,
        'NOT_FOUND',
      );
    if (run.version !== expectedVersion) throw new VersionConflictError(run);
    if (!['ready', 'invalid', 'failed'].includes(run.status))
      throw new SchedulingRuleError(
        'This import can no longer be discarded.',
        409,
        'CONFLICT',
      );
    await trx
      .updateTable('schedule_import_runs')
      .set({
        status: 'discarded',
        source: null,
        completed_at: new Date(),
        version: run.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .where('version', '=', run.version)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.import.discard',
      entityType: 'schedule_import_run',
      entityId: runId,
    });
  });
}

export async function importScheduleCsv(
  context: OrgContext,
  source: string,
  commit: boolean,
): Promise<{
  committed: boolean;
  imported: number;
  rows: Array<{ row: number; eventId?: string; errors: string[] }>;
}> {
  if (Buffer.byteLength(source, 'utf8') > 20 * 1024 * 1024)
    throw new SchedulingRuleError('CSV imports are limited to 20 MB.');
  const matrix = parseCsv(source);
  const headers = matrix[0]?.map((header) => header.trim().toLowerCase()) ?? [];
  const allowedHeaders = new Set<string>([
    ...importHeaders,
    ...optionalImportHeaders,
  ]);
  if (
    new Set(headers).size !== headers.length ||
    importHeaders.some((header) => !headers.includes(header)) ||
    headers.some((header) => !allowedHeaders.has(header))
  )
    throw new SchedulingRuleError(
      `CSV must include these headers: ${importHeaders.join(', ')} and either starts_at/ends_at or start_date/end_date with start_time/end_time.`,
    );
  if (
    !(headers.includes('starts_at') && headers.includes('ends_at')) &&
    !(
      headers.includes('start_date') &&
      headers.includes('end_date') &&
      headers.includes('start_time') &&
      headers.includes('end_time')
    )
  )
    throw new SchedulingRuleError(
      'Add starts_at and ends_at, or start_date, end_date, start_time, and end_time columns.',
    );
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const dataRows = matrix.slice(1);
  if (!dataRows.length)
    throw new SchedulingRuleError(
      'The import file must contain at least one schedule row.',
    );
  if (dataRows.length > 20_000)
    throw new SchedulingRuleError('CSV imports are limited to 20,000 rows.');
  const parsedRows: Array<{
    row: number;
    candidate: EventCreateWithOverrideInput;
    errors: string[];
  }> = [];
  for (const [index, cells] of dataRows.entries()) {
    const get = (key: string) => cells[indexes.get(key) ?? -1]?.trim() ?? '';
    const raw: CsvImportRow = {
      title: get('title'),
      kind: get('kind'),
      starts_at: get('starts_at'),
      ends_at: get('ends_at'),
      timezone: get('timezone'),
      program_id: get('program_id'),
      division_id: get('division_id'),
      space_id: get('space_id'),
      location_text: get('location_text'),
      home_team_season_id: get('home_team_season_id'),
      away_team_season_id: get('away_team_season_id'),
      override_reason: get('override_reason'),
      start_date: get('start_date'),
      end_date: get('end_date'),
      start_time: get('start_time'),
      end_time: get('end_time'),
    };
    const errors: string[] = [];
    try {
      const candidate = eventCreateWithOverrideSchema.parse({
        title: raw.title,
        kind: raw.kind,
        startsAt: importInstant(
          raw.starts_at,
          raw.start_date,
          raw.start_time,
          raw.timezone,
        ),
        endsAt: importInstant(
          raw.ends_at,
          raw.end_date,
          raw.end_time,
          raw.timezone,
        ),
        timezone: raw.timezone,
        programId: raw.program_id || null,
        divisionId: raw.division_id || null,
        spaceId: raw.space_id || null,
        locationText: raw.location_text || null,
        notesHtml: null,
        arrivalMinutesBefore: 0,
        participants: [
          ...(raw.home_team_season_id
            ? [
                {
                  type: 'team' as const,
                  id: raw.home_team_season_id,
                  side: 'home' as const,
                },
              ]
            : []),
          ...(raw.away_team_season_id
            ? [
                {
                  type: 'team' as const,
                  id: raw.away_team_season_id,
                  side: 'away' as const,
                },
              ]
            : []),
        ],
        published: false,
        ...(raw.override_reason ? { overrideReason: raw.override_reason } : {}),
      });
      parsedRows.push({ row: index + 2, candidate, errors });
    } catch (error) {
      errors.push(
        error instanceof z.ZodError
          ? error.issues.map((issue) => issue.message).join('; ')
          : 'Invalid date, time, or identifier.',
      );
      parsedRows.push({
        row: index + 2,
        candidate: {} as EventCreateWithOverrideInput,
        errors,
      });
    }
  }
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const accepted: Array<{
      row: number;
      candidate: EventCreateWithOverrideInput;
    }> = [];
    const teamIds = [
      ...new Set(
        parsedRows.flatMap((item) =>
          item.candidate.participants.flatMap((participant) =>
            participant.type === 'team' ? [participant.id] : [],
          ),
        ),
      ),
    ];
    const staffRows = teamIds.length
      ? await trx
          .selectFrom('team_staff')
          .select(['team_season_id', 'person_id'])
          .where('org_id', '=', context.orgId)
          .where('team_season_id', 'in', teamIds)
          .where('status', '=', 'active')
          .where('role', 'in', [
            'head_coach',
            'assistant_coach',
            'team_manager',
            'trainer',
          ])
          .execute()
      : [];
    const staffByTeam = new Map<string, string[]>();
    for (const staff of staffRows)
      staffByTeam.set(staff.team_season_id, [
        ...(staffByTeam.get(staff.team_season_id) ?? []),
        staff.person_id,
      ]);
    const draftRanges: Array<{
      row: number;
      starts: number;
      ends: number;
      leafIds: string[];
      teamIds: string[];
      staffIds: string[];
    }> = [];
    for (const item of parsedRows) {
      if (item.errors.length) continue;
      const conflicts = await getConflicts(trx, context, item.candidate);
      const hard = conflicts.filter((conflict) => !conflict.overridable);
      const soft = conflicts.filter((conflict) => conflict.overridable);
      if (hard.length)
        item.errors.push(...hard.map((conflict) => conflict.message));
      if (soft.length && !item.candidate.overrideReason)
        item.errors.push(
          ...soft.map(
            (conflict) =>
              `${conflict.message} Include an override_reason to continue.`,
          ),
        );
      const starts = Date.parse(item.candidate.startsAt);
      const ends = Date.parse(item.candidate.endsAt);
      const currentTeamIds = item.candidate.participants.flatMap((person) =>
        person.type === 'team' ? [person.id] : [],
      );
      const leafIds = item.candidate.spaceId
        ? await leafSpaceIds(trx, context.orgId, item.candidate.spaceId)
        : [];
      const staffIds = [
        ...new Set(
          currentTeamIds.flatMap((teamId) => staffByTeam.get(teamId) ?? []),
        ),
      ];
      const conflictRow = draftRanges.find(
        (draft) =>
          draft.starts < ends &&
          starts < draft.ends &&
          (currentTeamIds.some((id) => draft.teamIds.includes(id)) ||
            staffIds.some((id) => draft.staffIds.includes(id)) ||
            (leafIds.length > 0 &&
              draft.leafIds.some((id) => leafIds.includes(id)))),
      );
      if (conflictRow) {
        const sameSpace = leafIds.some((id) =>
          conflictRow.leafIds.includes(id),
        );
        const soft =
          currentTeamIds.some((id) => conflictRow.teamIds.includes(id)) ||
          staffIds.some((id) => conflictRow.staffIds.includes(id));
        if (sameSpace)
          item.errors.push(
            `Conflicts with the booked space in imported row ${String(conflictRow.row)}.`,
          );
        else if (soft && !item.candidate.overrideReason)
          item.errors.push(
            `Conflicts with a team or coach in imported row ${String(conflictRow.row)}; include override_reason to continue.`,
          );
      }
      draftRanges.push({
        row: item.row,
        starts,
        ends,
        leafIds,
        teamIds: currentTeamIds,
        staffIds,
      });
      accepted.push({ row: item.row, candidate: item.candidate });
    }
    const rows = parsedRows.map(({ row, errors }) => ({ row, errors }));
    const errorsExist = rows.some((row) => row.errors.length > 0);
    if (!commit || errorsExist) return { committed: false, imported: 0, rows };
    const eventIds: Array<{ row: number; id: string }> = [];
    for (const item of accepted) {
      const id = newId();
      const { timezone, bufferMinutes } = await resolveTimezoneAndBuffer(
        trx,
        context.orgId,
        item.candidate.spaceId,
        item.candidate.programId,
      );
      await trx
        .insertInto('events')
        .values({
          id,
          org_id: context.orgId,
          program_id: item.candidate.programId ?? null,
          division_id: item.candidate.divisionId ?? null,
          kind: item.candidate.kind,
          title: item.candidate.title,
          starts_at: new Date(item.candidate.startsAt),
          ends_at: new Date(item.candidate.endsAt),
          timezone,
          space_id: item.candidate.spaceId ?? null,
          location_text: item.candidate.locationText ?? null,
          notes_html: null,
          arrival_minutes_before: 0,
          published: false,
        })
        .execute();
      for (const participant of item.candidate.participants) {
        await trx
          .insertInto('event_participants')
          .values({
            id: newId(),
            org_id: context.orgId,
            event_id: id,
            team_season_id: participant.type === 'team' ? participant.id : null,
            external_team_id: null,
            person_id: null,
            division_id: null,
            side: participant.side,
          })
          .execute();
      }
      if (item.candidate.spaceId)
        await insertSpaceBooking(
          trx,
          context.orgId,
          item.candidate.spaceId,
          new Date(item.candidate.startsAt),
          new Date(item.candidate.endsAt),
          bufferMinutes,
          id,
        );
      eventIds.push({ row: item.row, id });
      if (item.candidate.overrideReason)
        await appendAuditEvent(trx, context, {
          action: 'schedule.csv_import.override',
          entityType: 'event',
          entityId: id,
          changes: {
            reason: { tier: 'internal', after: item.candidate.overrideReason },
          },
        });
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.csv_import',
      entityType: 'event',
      changes: { eventCount: { tier: 'internal', after: eventIds.length } },
    });
    const idsByRow = new Map(eventIds.map((item) => [item.row, item.id]));
    return {
      committed: true,
      imported: eventIds.length,
      rows: rows.map((row) => {
        const eventId = idsByRow.get(row.row);
        return { ...row, ...(eventId ? { eventId } : {}) };
      }),
    };
  });
}

export async function shiftGamesOnDate(
  context: OrgContext,
  input: {
    fromDate: string;
    toDate: string;
    timezone: string;
    overrideReason?: string;
  },
): Promise<{ eventIds: string[] }> {
  const from = Temporal.PlainDate.from(input.fromDate);
  const to = Temporal.PlainDate.from(input.toDate);
  const dayDelta = to.since(from).days;
  if (!dayDelta || Math.abs(dayDelta) > 370)
    throw new SchedulingRuleError('Choose a different date within 370 days.');
  const start = from
    .toZonedDateTime({ timeZone: input.timezone, plainTime: '00:00' })
    .toInstant();
  const end = from
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: input.timezone, plainTime: '00:00' })
    .toInstant();
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const events = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('kind', 'in', ['game', 'tournament_game', 'match'])
      .where('status', '=', 'scheduled')
      .where('starts_at', '>=', new Date(start.epochMilliseconds))
      .where('starts_at', '<', new Date(end.epochMilliseconds))
      .orderBy('starts_at')
      .limit(1000)
      .execute();
    if (!events.length) return { eventIds: [] };
    const eventIds = events.map((event) => event.id);
    const participantsByEvent = new Map<
      string,
      Array<{ type: 'team'; id: string; side: 'home' | 'away' | 'none' }>
    >();
    const refs = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', 'in', eventIds)
      .execute();
    for (const row of refs) {
      if (!row.team_season_id) continue;
      const list = participantsByEvent.get(row.event_id) ?? [];
      list.push({
        type: 'team',
        id: row.team_season_id,
        side: row.side as 'home' | 'away' | 'none',
      });
      participantsByEvent.set(row.event_id, list);
    }
    const moves = events.map((event) => {
      const localStart = Temporal.Instant.from(
        event.starts_at.toISOString(),
      ).toZonedDateTimeISO(event.timezone);
      const localEnd = Temporal.Instant.from(
        event.ends_at.toISOString(),
      ).toZonedDateTimeISO(event.timezone);
      const localStartDate = localStart.toPlainDate();
      const endDayOffset = localEnd.toPlainDate().since(localStartDate).days;
      const targetStartDate = localStartDate.add({ days: dayDelta });
      const targetEndDate = targetStartDate.add({ days: endDayOffset });
      const nextStart = targetStartDate
        .toPlainDateTime(localStart.toPlainTime())
        .toZonedDateTime(event.timezone, { disambiguation: 'compatible' })
        .toInstant();
      const nextEnd = targetEndDate
        .toPlainDateTime(localEnd.toPlainTime())
        .toZonedDateTime(event.timezone, { disambiguation: 'compatible' })
        .toInstant();
      return {
        event,
        startsAt: new Date(nextStart.epochMilliseconds),
        endsAt: new Date(nextEnd.epochMilliseconds),
      };
    });
    const movedParticipants = new Map(
      moves.map((move) => [
        move.event.id,
        participantsByEvent.get(move.event.id) ?? [],
      ]),
    );
    const allMovedTeams = [
      ...new Set(
        moves.flatMap(
          (move) =>
            movedParticipants
              .get(move.event.id)
              ?.map((participant) => participant.id) ?? [],
        ),
      ),
    ];
    const staffRows = allMovedTeams.length
      ? await trx
          .selectFrom('team_staff')
          .select(['team_season_id', 'person_id'])
          .where('org_id', '=', context.orgId)
          .where('team_season_id', 'in', allMovedTeams)
          .where('status', '=', 'active')
          .where('role', 'in', [
            'head_coach',
            'assistant_coach',
            'team_manager',
            'trainer',
          ])
          .execute()
      : [];
    const staffByTeam = new Map<string, string[]>();
    for (const staff of staffRows)
      staffByTeam.set(staff.team_season_id, [
        ...(staffByTeam.get(staff.team_season_id) ?? []),
        staff.person_id,
      ]);
    const acceptedMoves: Array<{
      eventId: string;
      starts: number;
      ends: number;
      teams: string[];
      leaves: string[];
      staff: string[];
    }> = [];
    for (const move of moves) {
      const candidate = {
        kind: move.event.kind as EventCreateWithOverrideInput['kind'],
        title: move.event.title,
        startsAt: move.startsAt.toISOString(),
        endsAt: move.endsAt.toISOString(),
        timezone: move.event.timezone,
        programId: move.event.program_id,
        divisionId: move.event.division_id,
        spaceId: move.event.space_id,
        locationText: move.event.location_text,
        notesHtml: move.event.notes_html,
        arrivalMinutesBefore: move.event.arrival_minutes_before,
        participants: participantsByEvent.get(move.event.id) ?? [],
        published: move.event.published,
        overrideReason: input.overrideReason,
      } as EventCreateWithOverrideInput;
      const conflicts = await getConflicts(trx, context, candidate, eventIds);
      const hard = conflicts.filter((conflict) => !conflict.overridable);
      const soft = conflicts.filter((conflict) => conflict.overridable);
      if (hard.length || (soft.length && !input.overrideReason))
        throw new SchedulingRuleError(
          'At least one game conflicts with the destination schedule.',
          409,
          'SCHEDULE_CONFLICT',
          { conflicts },
        );
      const teams = (participantsByEvent.get(move.event.id) ?? []).map(
        (participant) => participant.id,
      );
      const staff = [
        ...new Set(teams.flatMap((teamId) => staffByTeam.get(teamId) ?? [])),
      ];
      const leaves = move.event.space_id
        ? await leafSpaceIds(trx, context.orgId, move.event.space_id)
        : [];
      const startMs = move.startsAt.getTime();
      const endMs = move.endsAt.getTime();
      const internal = acceptedMoves.find(
        (prior) =>
          prior.starts < endMs &&
          startMs < prior.ends &&
          (teams.some((teamId) => prior.teams.includes(teamId)) ||
            staff.some((personId) => prior.staff.includes(personId)) ||
            leaves.some((leafId) => prior.leaves.includes(leafId))),
      );
      if (internal) {
        const sameSpace = leaves.some((leafId) =>
          internal.leaves.includes(leafId),
        );
        const sameTeamOrCoach =
          teams.some((teamId) => internal.teams.includes(teamId)) ||
          staff.some((personId) => internal.staff.includes(personId));
        if (sameSpace || (sameTeamOrCoach && !input.overrideReason))
          throw new SchedulingRuleError(
            'The moved games conflict with one another at the destination.',
            409,
            'SCHEDULE_CONFLICT',
            {
              eventIds: [internal.eventId, move.event.id],
              kind: sameSpace ? 'space' : 'team_or_coach',
            },
          );
      }
      acceptedMoves.push({
        eventId: move.event.id,
        starts: startMs,
        ends: endMs,
        teams,
        leaves,
        staff,
      });
    }
    await trx
      .deleteFrom('space_bookings')
      .where('org_id', '=', context.orgId)
      .where('event_id', 'in', eventIds)
      .execute();
    for (const move of moves) {
      const updated = await trx
        .updateTable('events')
        .set({
          starts_at: move.startsAt,
          ends_at: move.endsAt,
          version: move.event.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', move.event.id)
        .where('version', '=', move.event.version)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new VersionConflictError(move.event);
      if (updated.space_id) {
        const { bufferMinutes } = await resolveTimezoneAndBuffer(
          trx,
          context.orgId,
          updated.space_id,
          updated.program_id,
        );
        await insertSpaceBooking(
          trx,
          context.orgId,
          updated.space_id,
          updated.starts_at,
          updated.ends_at,
          bufferMinutes,
          updated.id,
        );
      }
      if (updated.published)
        await queueChangeBatch(
          trx,
          context,
          {
            id: updated.id,
            title: updated.title,
            startsAt: updated.starts_at.toISOString(),
            endsAt: updated.ends_at.toISOString(),
          },
          await eventRecipients(
            trx,
            context.orgId,
            participantsByEvent.get(updated.id) ?? [],
          ),
          'updated',
        );
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.games.bulk_shift',
      entityType: 'event',
      changes: {
        count: { tier: 'internal', after: moves.length },
        from: { tier: 'internal', after: input.fromDate },
        to: { tier: 'internal', after: input.toDate },
      },
    });
    if (input.overrideReason)
      await appendAuditEvent(trx, context, {
        action: 'schedule.games.bulk_shift.override',
        entityType: 'event',
        changes: {
          reason: { tier: 'internal', after: input.overrideReason },
          count: { tier: 'internal', after: moves.length },
        },
      });
    return { eventIds };
  });
}

export async function swapHomeAway(
  context: OrgContext,
  eventId: string,
  expectedVersion: number,
): Promise<void> {
  await withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const event = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event)
      throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
    if (event.version !== expectedVersion)
      throw new VersionConflictError(event);
    if (event.status !== 'scheduled' || event.starts_at <= new Date())
      throw new SchedulingRuleError(
        'Home and away can only be swapped before a scheduled event starts.',
        409,
        'CONFLICT',
      );
    const contest = await trx
      .selectFrom('contests')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (contest && contest.status !== 'scheduled')
      throw new SchedulingRuleError(
        'Home and away cannot change after result entry begins.',
        409,
        'CONFLICT',
      );
    const participants = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const teams = participants.filter(
      (item) =>
        item.team_season_id && (item.side === 'home' || item.side === 'away'),
    );
    if (teams.length !== 2)
      throw new SchedulingRuleError(
        'This event does not have exactly two teams.',
        409,
        'CONFLICT',
      );
    for (const participant of teams) {
      const side = participant.side === 'home' ? 'away' : 'home';
      await trx
        .updateTable('event_participants')
        .set({ side })
        .where('org_id', '=', context.orgId)
        .where('id', '=', participant.id)
        .execute();
      if (contest) {
        const resultParticipant = await trx
          .selectFrom('contest_participants')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('contest_id', '=', contest.id)
          .where('team_season_id', '=', participant.team_season_id ?? '')
          .executeTakeFirst();
        if (resultParticipant)
          await trx
            .updateTable('contest_participants')
            .set({ side })
            .where('org_id', '=', context.orgId)
            .where('id', '=', resultParticipant.id)
            .execute();
      }
    }
    const updated = await trx
      .updateTable('events')
      .set({ version: event.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(event);
    if (event.published) {
      const people = participants.flatMap((item) => [
        ...(item.person_id
          ? [
              {
                type: 'person' as const,
                id: item.person_id,
                side: item.side as 'home' | 'away' | 'none',
              },
            ]
          : []),
        ...(item.team_season_id
          ? [
              {
                type: 'team' as const,
                id: item.team_season_id,
                side: item.side as 'home' | 'away' | 'none',
              },
            ]
          : []),
      ]);
      await queueChangeBatch(
        trx,
        context,
        {
          id: eventId,
          title: event.title,
          startsAt: event.starts_at.toISOString(),
          endsAt: event.ends_at.toISOString(),
        },
        await eventRecipients(trx, context.orgId, people),
        'updated',
      );
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.event.swap_home_away',
      entityType: 'event',
      entityId: eventId,
    });
  });
}

export async function createSpaceAvailability(
  context: OrgContext,
  input: {
    spaceId: string;
    recurrence: import('@shared/recurrence').Recurrence;
    startsOn: string;
    endsOn: string;
    startTime: string;
    endTime: string;
    timezone: string;
    source: 'owned' | 'permit';
    permitReference?: string | null;
    costPerHourCents?: number | null;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const resolved = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      input.spaceId,
      null,
    );
    if (input.timezone !== resolved.timezone)
      throw new SchedulingRuleError(
        'Availability timezone must match the selected facility timezone.',
      );
    if (input.startsOn > input.endsOn || input.startTime >= input.endTime)
      throw new SchedulingRuleError(
        'Availability dates and times must be increasing.',
      );
    const duration =
      (Date.parse(`2000-01-01T${input.endTime}Z`) -
        Date.parse(`2000-01-01T${input.startTime}Z`)) /
      60_000;
    const windows = expand(
      {
        recurrence: input.recurrence,
        startTime: input.startTime,
        durationMinutes: duration,
        timezone: input.timezone,
      },
      input.startsOn,
      input.endsOn,
    );
    if (windows.length > 1500)
      throw new SchedulingRuleError(
        'Availability may include at most 1,500 dates.',
      );
    const id = newId();
    await trx
      .insertInto('space_availability')
      .values({
        id,
        org_id: context.orgId,
        space_id: input.spaceId,
        recurrence: input.recurrence as unknown as Json,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
        start_time: input.startTime,
        end_time: input.endTime,
        source: input.source,
        permit_reference: input.permitReference ?? null,
        cost_per_hour_cents: input.costPerHourCents ?? null,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.availability.create',
      entityType: 'space_availability',
      entityId: id,
    });
    return trx
      .selectFrom('space_availability')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
}

export async function listSpaceAvailability(
  context: OrgContext,
  spaceId: string,
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.read');
    return trx
      .selectFrom('space_availability')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('space_id', '=', spaceId)
      .orderBy('starts_on')
      .execute();
  });
}

export async function createSpaceBlackout(
  context: OrgContext,
  input: {
    scopeType: 'facility' | 'space';
    scopeId: string;
    startsAt: string;
    endsAt: string;
    reason: string;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    if (new Date(input.startsAt) >= new Date(input.endsAt))
      throw new SchedulingRuleError('Blackout end must follow its start.');
    const id = newId();
    await trx
      .insertInto('space_blackouts')
      .values({
        id,
        org_id: context.orgId,
        space_id: input.scopeType === 'space' ? input.scopeId : null,
        facility_id: input.scopeType === 'facility' ? input.scopeId : null,
        starts_at: new Date(input.startsAt),
        ends_at: new Date(input.endsAt),
        reason: input.reason,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.blackout.create',
      entityType: 'space_blackout',
      entityId: id,
    });
    return trx
      .selectFrom('space_blackouts')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
}

export async function updateScheduleSettings(
  context: OrgContext,
  input: {
    programId: string;
    coachSlotPickerEnabled: boolean;
    slotApprovalRequired: boolean;
    expectedVersion?: number;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: input.programId,
    });
    const current = await trx
      .selectFrom('schedule_settings')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', input.programId)
      .executeTakeFirst();
    if (!current) {
      if (input.expectedVersion !== undefined)
        throw new VersionConflictError(null);
      const created = await trx
        .insertInto('schedule_settings')
        .values({
          id: newId(),
          org_id: context.orgId,
          program_id: input.programId,
          coach_slot_picker_enabled: input.coachSlotPickerEnabled,
          slot_approval_required: input.slotApprovalRequired,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return created;
    }
    if (input.expectedVersion !== current.version)
      throw new VersionConflictError(current);
    return trx
      .updateTable('schedule_settings')
      .set({
        coach_slot_picker_enabled: input.coachSlotPickerEnabled,
        slot_approval_required: input.slotApprovalRequired,
        version: current.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', current.id)
      .where('version', '=', current.version)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function createTeamBlackoutRequest(
  context: OrgContext,
  teamSeasonId: string,
  input: { startsOn: string; endsOn: string; reason: string },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'attendance.manage', {
      teamSeasonId,
    });
    if (input.startsOn > input.endsOn)
      throw new SchedulingRuleError(
        'Blackout end date must follow its start date.',
      );
    const id = newId();
    await trx
      .insertInto('schedule_blackout_requests')
      .values({
        id,
        org_id: context.orgId,
        team_season_id: teamSeasonId,
        requested_by: context.actor.accountId,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
        reason: input.reason,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.blackout.request',
      entityType: 'schedule_blackout_request',
      entityId: id,
    });
    return trx
      .selectFrom('schedule_blackout_requests')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
}

export async function decideTeamBlackoutRequest(
  context: OrgContext,
  requestId: string,
  input: { approve: boolean; expectedVersion: number },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const current = await trx
      .selectFrom('schedule_blackout_requests')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!current)
      throw new SchedulingRuleError(
        'Blackout request not found.',
        404,
        'NOT_FOUND',
      );
    if (current.version !== input.expectedVersion)
      throw new VersionConflictError(current);
    if (current.status !== 'pending')
      throw new SchedulingRuleError(
        'Blackout request has already been decided.',
        409,
        'CONFLICT',
      );
    const updated = await trx
      .updateTable('schedule_blackout_requests')
      .set({
        status: input.approve ? 'approved' : 'declined',
        decided_by: context.actor.accountId,
        version: current.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .where('version', '=', current.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(current);
    await appendAuditEvent(trx, context, {
      action: `schedule.blackout.${input.approve ? 'approve' : 'decline'}`,
      entityType: 'schedule_blackout_request',
      entityId: requestId,
    });
    return updated;
  });
}
