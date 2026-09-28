import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';

import { RegistrationCheckoutError } from './checkout-start.js';

export const registrationReportFilterSchema = z.strictObject({
  programId: z.uuid().optional(),
  divisionId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  status: z
    .enum([
      'pending_payment',
      'pending_approval',
      'waitlisted',
      'offered',
      'confirmed',
      'canceled',
      'withdrawn',
      'transferred_out',
    ])
    .optional(),
});

const reportItemSchema = z.strictObject({
  registrationId: z.uuid(),
  participantName: z.string(),
  programId: z.uuid(),
  programName: z.string(),
  divisionId: z.uuid().nullable(),
  divisionName: z.string().nullable(),
  offeringId: z.uuid(),
  offeringName: z.string(),
  teamName: z.string().nullable(),
  status: z.string(),
  registeredAt: z.iso.datetime(),
});

export const registrationReportSchema = z.strictObject({
  filters: registrationReportFilterSchema,
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  registrations: z.array(reportItemSchema),
});

export const uniformSizeReportSchema = z.strictObject({
  filters: registrationReportFilterSchema,
  items: z.array(
    z.strictObject({
      programId: z.uuid(),
      programName: z.string(),
      divisionId: z.uuid().nullable(),
      divisionName: z.string().nullable(),
      teamName: z.string().nullable(),
      addOnKey: z.string(),
      addOnName: z.string(),
      size: z.string().nullable(),
      quantity: z.number().int().nonnegative(),
      registrations: z.number().int().nonnegative(),
    }),
  ),
});

export const registrationPaceSchema = z.strictObject({
  programId: z.uuid(),
  previousProgramId: z.uuid().nullable(),
  days: z.array(
    z.strictObject({
      dayOffset: z.number().int().nonnegative(),
      current: z.number().int().nonnegative(),
      previous: z.number().int().nonnegative().nullable(),
    }),
  ),
});

interface ReportItemRow {
  registration_id: string;
  participant_name: string;
  program_id: string;
  program_name: string;
  division_id: string | null;
  division_name: string | null;
  offering_id: string;
  offering_name: string;
  team_name: string | null;
  status: string;
  registered_at: Date;
  total: number;
}

interface UniformRow {
  program_id: string;
  program_name: string;
  division_id: string | null;
  division_name: string | null;
  team_name: string | null;
  add_on_key: string;
  add_on_name: string;
  size: string | null;
  quantity: number;
  registrations: number;
}

interface PaceRow {
  program_id: string;
  day_offset: number | null;
  registrations: number;
  current_day: number;
}

const MAX_REPORT_ROWS = 10_000;

async function requireStaffReporter(
  trx: OrgTransaction,
  orgId: string,
  accountId: string,
): Promise<void> {
  const allowed = await sql<{ allowed: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM role_assignments ra
      JOIN org_memberships m ON m.org_id = ra.org_id
        AND m.account_id = ra.account_id AND m.status = 'active'
      WHERE ra.org_id = ${orgId}::uuid
        AND ra.account_id = ${accountId}::uuid
        AND ra.role IN ('owner', 'admin', 'registrar')
        AND ra.pending_mfa = false AND ra.revoked_at IS NULL
    ) AS allowed
  `.execute(trx);
  if (!allowed.rows[0]?.allowed)
    throw new RegistrationCheckoutError(
      403,
      'FORBIDDEN',
      'Registration staff access is required',
    );
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function registrationReportCsv(
  report: z.output<typeof registrationReportSchema>,
): string {
  const columns = [
    'Registration ID',
    'Participant',
    'Program',
    'Division',
    'Offering',
    'Team',
    'Status',
    'Registered At',
  ];
  return [
    columns.map(csvCell).join(','),
    ...report.registrations.map((row) =>
      [
        row.registrationId,
        row.participantName,
        row.programName,
        row.divisionName,
        row.offeringName,
        row.teamName,
        row.status,
        row.registeredAt,
      ]
        .map(csvCell)
        .join(','),
    ),
  ].join('\r\n');
}

export class PostgresRegistrationReports {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async list(input: {
    orgId: string;
    filters: z.input<typeof registrationReportFilterSchema>;
  }): Promise<z.output<typeof registrationReportSchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    const filters = registrationReportFilterSchema.parse(input.filters);
    const rows = await this.withOrg(this.context, async (trx) => {
      await requireStaffReporter(
        trx,
        input.orgId,
        this.context.actor.accountId,
      );
      const result = await sql<ReportItemRow>`
        SELECT r.id AS registration_id,
          person.first_name || ' ' || person.last_name AS participant_name,
          p.id AS program_id, p.name AS program_name,
          d.id AS division_id, d.name AS division_name,
          o.id AS offering_id, o.name AS offering_name,
          coalesce(ts.display_name, team.name) AS team_name,
          r.status, r.created_at AS registered_at,
          count(*) OVER()::integer AS total
        FROM registrations r
        JOIN people person ON person.org_id = r.org_id AND person.id = r.person_id
        JOIN programs p ON p.org_id = r.org_id AND p.id = r.program_id
        LEFT JOIN divisions d ON d.org_id = r.org_id AND d.id = r.division_id
        JOIN registration_offerings o ON o.org_id = r.org_id AND o.id = r.offering_id
        LEFT JOIN team_seasons ts ON ts.org_id = r.org_id AND ts.id = r.team_season_id
        LEFT JOIN teams team ON team.org_id = ts.org_id AND team.id = ts.team_id
        WHERE r.org_id = ${input.orgId}::uuid
          AND (${filters.programId ?? null}::uuid IS NULL OR r.program_id = ${filters.programId ?? null}::uuid)
          AND (${filters.divisionId ?? null}::uuid IS NULL OR r.division_id = ${filters.divisionId ?? null}::uuid)
          AND (${filters.offeringId ?? null}::uuid IS NULL OR r.offering_id = ${filters.offeringId ?? null}::uuid)
          AND (${filters.status ?? null}::text IS NULL OR r.status = ${filters.status ?? null}::text)
          AND EXISTS (
            SELECT 1 FROM role_assignments ra
            JOIN org_memberships m ON m.org_id = ra.org_id
              AND m.account_id = ra.account_id AND m.status = 'active'
            WHERE ra.org_id = r.org_id
              AND ra.account_id = ${this.context.actor.accountId}::uuid
              AND ra.role IN ('owner', 'admin', 'registrar')
              AND ra.pending_mfa = false AND ra.revoked_at IS NULL
              AND (
                ra.scope_type = 'org' OR
                (ra.scope_type = 'program' AND ra.scope_id = r.program_id) OR
                (ra.scope_type = 'division' AND ra.scope_id = r.division_id) OR
                (ra.scope_type = 'season' AND ra.scope_id = p.season_id) OR
                (ra.scope_type = 'team_season' AND ra.scope_id = r.team_season_id)
              )
          )
        ORDER BY r.created_at DESC, r.id
        LIMIT ${MAX_REPORT_ROWS}
      `.execute(trx);
      return result.rows;
    });
    return registrationReportSchema.parse({
      filters,
      total: rows[0]?.total ?? 0,
      truncated: (rows[0]?.total ?? 0) > rows.length,
      registrations: rows.map((row) => ({
        registrationId: row.registration_id,
        participantName: row.participant_name,
        programId: row.program_id,
        programName: row.program_name,
        divisionId: row.division_id,
        divisionName: row.division_name,
        offeringId: row.offering_id,
        offeringName: row.offering_name,
        teamName: row.team_name,
        status: row.status,
        registeredAt: row.registered_at.toISOString(),
      })),
    });
  }

  async uniformSizes(input: {
    orgId: string;
    filters: z.input<typeof registrationReportFilterSchema>;
  }): Promise<z.output<typeof uniformSizeReportSchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    const filters = registrationReportFilterSchema.parse(input.filters);
    const rows = await this.withOrg(this.context, async (trx) => {
      await requireStaffReporter(
        trx,
        input.orgId,
        this.context.actor.accountId,
      );
      const result = await sql<UniformRow>`
        SELECT p.id AS program_id, p.name AS program_name,
          d.id AS division_id, d.name AS division_name,
          coalesce(ts.display_name, team.name) AS team_name,
          selection.line_key AS add_on_key, selection.name AS add_on_name,
          selection.size, sum(selection.quantity)::integer AS quantity,
          count(DISTINCT r.id)::integer AS registrations
        FROM registration_add_on_selections selection
        JOIN registrations r ON r.org_id = selection.org_id
          AND r.id = selection.registration_id
        JOIN programs p ON p.org_id = r.org_id AND p.id = r.program_id
        LEFT JOIN divisions d ON d.org_id = r.org_id AND d.id = r.division_id
        LEFT JOIN registration_offerings o ON o.org_id = r.org_id AND o.id = r.offering_id
        LEFT JOIN team_seasons ts ON ts.org_id = r.org_id AND ts.id = r.team_season_id
        LEFT JOIN teams team ON team.org_id = ts.org_id AND team.id = ts.team_id
        WHERE r.org_id = ${input.orgId}::uuid
          AND (${filters.programId ?? null}::uuid IS NULL OR r.program_id = ${filters.programId ?? null}::uuid)
          AND (${filters.divisionId ?? null}::uuid IS NULL OR r.division_id = ${filters.divisionId ?? null}::uuid)
          AND (${filters.offeringId ?? null}::uuid IS NULL OR r.offering_id = ${filters.offeringId ?? null}::uuid)
          AND (${filters.status ?? null}::text IS NULL OR r.status = ${filters.status ?? null}::text)
          AND EXISTS (
            SELECT 1 FROM role_assignments ra
            JOIN org_memberships m ON m.org_id = ra.org_id
              AND m.account_id = ra.account_id AND m.status = 'active'
            WHERE ra.org_id = r.org_id
              AND ra.account_id = ${this.context.actor.accountId}::uuid
              AND ra.role IN ('owner', 'admin', 'registrar')
              AND ra.pending_mfa = false AND ra.revoked_at IS NULL
              AND (
                ra.scope_type = 'org' OR
                (ra.scope_type = 'program' AND ra.scope_id = r.program_id) OR
                (ra.scope_type = 'division' AND ra.scope_id = r.division_id) OR
                (ra.scope_type = 'season' AND ra.scope_id = p.season_id) OR
                (ra.scope_type = 'team_season' AND ra.scope_id = r.team_season_id)
              )
          )
        GROUP BY p.id, p.name, d.id, d.name, ts.display_name, team.name,
          selection.line_key, selection.name, selection.size
        ORDER BY p.name, d.name NULLS FIRST, team_name NULLS FIRST,
          selection.name, selection.size NULLS FIRST
        LIMIT ${MAX_REPORT_ROWS}
      `.execute(trx);
      return result.rows;
    });
    return uniformSizeReportSchema.parse({
      filters,
      items: rows.map((row) => ({
        programId: row.program_id,
        programName: row.program_name,
        divisionId: row.division_id,
        divisionName: row.division_name,
        teamName: row.team_name,
        addOnKey: row.add_on_key,
        addOnName: row.add_on_name,
        size: row.size,
        quantity: row.quantity,
        registrations: row.registrations,
      })),
    });
  }

  async pace(input: {
    orgId: string;
    programId: string;
    now?: Date;
  }): Promise<z.output<typeof registrationPaceSchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    const programId = z.uuid().parse(input.programId);
    return this.withOrg(this.context, async (trx) => {
      await requireStaffReporter(
        trx,
        input.orgId,
        this.context.actor.accountId,
      );
      const access = await sql<{
        previous_program_id: string | null;
        opens_at: Date | null;
        season_id: string;
        timezone: string;
      }>`
        SELECT p.copied_from_program_id AS previous_program_id,
          p.registration_opens_at AS opens_at, p.season_id, org.timezone
        FROM programs p JOIN organizations org ON org.id = p.org_id
        WHERE p.org_id = ${input.orgId}::uuid AND p.id = ${programId}::uuid
          AND EXISTS (
            SELECT 1 FROM role_assignments ra
            JOIN org_memberships m ON m.org_id = ra.org_id
              AND m.account_id = ra.account_id AND m.status = 'active'
            WHERE ra.org_id = p.org_id
              AND ra.account_id = ${this.context.actor.accountId}::uuid
              AND ra.role IN ('owner', 'admin', 'registrar')
              AND ra.pending_mfa = false AND ra.revoked_at IS NULL
              AND (
                ra.scope_type = 'org' OR
                (ra.scope_type = 'program' AND ra.scope_id = p.id) OR
                (ra.scope_type = 'season' AND ra.scope_id = p.season_id) OR
                (ra.scope_type = 'division' AND EXISTS (
                  SELECT 1 FROM divisions d WHERE d.org_id = p.org_id
                    AND d.program_id = p.id AND d.id = ra.scope_id
                ))
              )
          )
      `.execute(trx);
      const metadata = access.rows[0];
      if (!metadata)
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Program is unavailable',
        );
      if (!metadata.opens_at)
        throw new RegistrationCheckoutError(
          409,
          'REGISTRATION_NOT_OPENED',
          'Registration opening time is unavailable',
        );
      const previousProgramId = metadata.previous_program_id;
      const paceRows = await sql<PaceRow>`
        SELECT p.id AS program_id,
          ((r.created_at AT TIME ZONE ${metadata.timezone})::date -
            (p.registration_opens_at AT TIME ZONE ${metadata.timezone})::date)::integer AS day_offset,
          count(r.id)::integer AS registrations,
          greatest(0, ((${input.now ?? new Date()}::timestamptz AT TIME ZONE ${metadata.timezone})::date -
            (current.registration_opens_at AT TIME ZONE ${metadata.timezone})::date)::integer) AS current_day
        FROM programs current
        JOIN organizations org ON org.id = current.org_id
        JOIN programs p ON p.org_id = current.org_id
          AND p.id IN (current.id, current.copied_from_program_id)
        LEFT JOIN registrations r ON r.org_id = p.org_id AND r.program_id = p.id
          AND r.created_at >= p.registration_opens_at
          AND r.status NOT IN ('canceled', 'withdrawn', 'transferred_out')
          AND EXISTS (
            SELECT 1 FROM role_assignments ra
            JOIN org_memberships m ON m.org_id = ra.org_id
              AND m.account_id = ra.account_id AND m.status = 'active'
            WHERE ra.org_id = r.org_id
              AND ra.account_id = ${this.context.actor.accountId}::uuid
              AND ra.role IN ('owner', 'admin', 'registrar')
              AND ra.pending_mfa = false AND ra.revoked_at IS NULL
              AND (
                ra.scope_type = 'org' OR
                (ra.scope_type = 'program' AND ra.scope_id = r.program_id) OR
                (ra.scope_type = 'division' AND ra.scope_id = r.division_id) OR
                (ra.scope_type = 'season' AND ra.scope_id = p.season_id) OR
                (ra.scope_type = 'team_season' AND ra.scope_id = r.team_season_id)
              )
          )
        WHERE current.org_id = ${input.orgId}::uuid AND current.id = ${programId}::uuid
          AND p.registration_opens_at IS NOT NULL
        GROUP BY 1, 2, 4
      `.execute(trx);
      const dayCounts = new Map<string, Map<number, number>>([
        [programId, new Map<number, number>()],
        ...(previousProgramId
          ? [[previousProgramId, new Map<number, number>()] as const]
          : []),
      ]);
      let asOf = 0;
      for (const row of paceRows.rows) {
        asOf = Math.max(asOf, row.current_day);
        if (row.day_offset === null) continue;
        const counts =
          dayCounts.get(row.program_id) ?? new Map<number, number>();
        counts.set(row.day_offset, row.registrations);
        dayCounts.set(row.program_id, counts);
      }
      const maxOffset = Math.min(
        3660,
        Math.max(
          asOf,
          ...[...dayCounts.values()].flatMap((counts) => [...counts.keys()]),
        ),
      );
      let currentTotal = 0;
      let previousTotal = 0;
      const currentCounts = dayCounts.get(programId);
      const previousCounts = previousProgramId
        ? dayCounts.get(previousProgramId)
        : undefined;
      const days = Array.from({ length: maxOffset + 1 }, (_, dayOffset) => {
        currentTotal += currentCounts?.get(dayOffset) ?? 0;
        previousTotal += previousCounts?.get(dayOffset) ?? 0;
        return {
          dayOffset,
          current: currentTotal,
          previous: previousCounts ? previousTotal : null,
        };
      });
      return registrationPaceSchema.parse({
        programId,
        previousProgramId,
        days,
      });
    });
  }
}
