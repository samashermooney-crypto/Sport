import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

export class AidAwardConflictError extends Error {}

export type AidAwardDecision =
  | { kind: 'fixed'; amountCents: number }
  | { kind: 'percent'; bps: number; maxCents: number };

interface ApplicationRow {
  id: string;
  financial_aid_program_id: string;
  household_id: string;
  program_ids: string[];
  requested_cents: number;
  award_cents: number;
  award_kind: string | null;
  award_bps: number | null;
  award_operation_key: string | null;
  award_request_hash: string | null;
  status: string;
  version: number;
}

export interface AwardedAid {
  applicationId: string;
  status: 'awarded' | 'partially_awarded';
  awardCents: number;
  awardKind: 'fixed' | 'percent';
  awardBps: number | null;
  version: number;
}

/** Reserves the award's maximum cents against one season budget exactly once. */
export class PostgresAidAwards {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async award(input: {
    orgId: string;
    applicationId: string;
    expectedVersion: number;
    operationKey: string;
    decision: AidAwardDecision;
  }): Promise<AwardedAid> {
    if (input.orgId !== this.context.orgId)
      throw new AidAwardConflictError('Aid organization mismatch');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.operationKey,
      )
    )
      throw new RangeError('Aid award operation key must be a UUID');
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    )
      throw new RangeError('Aid application version is invalid');
    const awardCents =
      input.decision.kind === 'fixed'
        ? input.decision.amountCents
        : input.decision.maxCents;
    const awardBps =
      input.decision.kind === 'percent' ? input.decision.bps : null;
    if (
      !Number.isSafeInteger(awardCents) ||
      awardCents < 1 ||
      (awardBps !== null &&
        (!Number.isInteger(awardBps) || awardBps < 1 || awardBps > 10_000))
    )
      throw new RangeError('Aid award must have positive cents and valid bps');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          applicationId: input.applicationId,
          expectedVersion: input.expectedVersion,
          decision: input.decision,
        }),
      )
      .digest('hex');
    return this.withOrg(this.context, async (trx) => {
      const pointer = await trx
        .selectFrom('aid_applications')
        .select('financial_aid_program_id')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.applicationId)
        .executeTakeFirst();
      if (!pointer)
        throw new AidAwardConflictError('Aid application unavailable');
      const program = await trx
        .selectFrom('financial_aid_programs')
        .select(['id', 'season_id', 'status', 'budget_cents', 'awarded_cents'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', pointer.financial_aid_program_id)
        .forUpdate()
        .executeTakeFirst();
      if (!program) throw new AidAwardConflictError('Aid program unavailable');
      const result = await sql<ApplicationRow>`
        SELECT id, financial_aid_program_id, household_id, program_ids,
          requested_cents, award_cents, award_kind, award_bps,
          award_operation_key, award_request_hash, status, version
        FROM aid_applications
        WHERE org_id = ${input.orgId}::uuid
          AND id = ${input.applicationId}::uuid FOR UPDATE
      `.execute(trx);
      const application = result.rows[0];
      if (!application || application.financial_aid_program_id !== program.id)
        throw new AidAwardConflictError('Aid application changed');
      if (application.award_operation_key) {
        if (
          application.award_operation_key !== input.operationKey ||
          application.award_request_hash !== requestHash ||
          (application.status !== 'awarded' &&
            application.status !== 'partially_awarded')
        )
          throw new AidAwardConflictError('Aid award was already decided');
        return this.view(application);
      }
      if (
        program.status !== 'open' ||
        !['submitted', 'under_review'].includes(application.status) ||
        application.version !== input.expectedVersion ||
        awardCents > application.requested_cents ||
        application.award_cents !== 0 ||
        application.award_kind !== null
      )
        throw new AidAwardConflictError('Aid application is not awardable');
      const household = await trx
        .selectFrom('households')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('id', '=', application.household_id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!household)
        throw new AidAwardConflictError('Aid household is unavailable');
      if (application.program_ids.length) {
        const programs = await trx
          .selectFrom('programs')
          .select('id')
          .where('org_id', '=', input.orgId)
          .where('id', 'in', application.program_ids)
          .where('season_id', '=', program.season_id)
          .execute();
        if (programs.length !== new Set(application.program_ids).size)
          throw new AidAwardConflictError('Aid scope is outside the season');
      }
      const status =
        awardCents === application.requested_cents
          ? 'awarded'
          : 'partially_awarded';
      const reservation = await trx
        .updateTable('financial_aid_programs')
        .set({
          awarded_cents: sql`awarded_cents + ${awardCents}`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', program.id)
        .where(sql<boolean>`awarded_cents <= budget_cents - ${awardCents}`)
        .executeTakeFirst();
      if (reservation.numUpdatedRows !== 1n)
        throw new AidAwardConflictError('Aid budget is exhausted');
      const updated = await sql<ApplicationRow>`
        UPDATE aid_applications SET award_cents = ${awardCents},
          award_kind = ${input.decision.kind}, award_bps = ${awardBps},
          award_operation_key = ${input.operationKey}::uuid,
          award_request_hash = ${requestHash}, status = ${status},
          decided_by = ${this.context.actor.accountId}::uuid,
          version = version + 1
        WHERE org_id = ${input.orgId}::uuid
          AND id = ${input.applicationId}::uuid RETURNING
          id, financial_aid_program_id, household_id, program_ids,
          requested_cents, award_cents, award_kind, award_bps,
          award_operation_key, award_request_hash, status, version
      `.execute(trx);
      const row = updated.rows[0];
      if (!row) throw new Error('Aid award changed during update');
      await appendAuditEvent(trx, this.context, {
        action: 'aid.awarded',
        entityType: 'aid_application',
        entityId: input.applicationId,
        changes: {
          awardCents: { tier: 'restricted', after: awardCents },
          awardKind: { tier: 'restricted', after: input.decision.kind },
        },
      });
      return this.view(row);
    });
  }

  private view(row: ApplicationRow): AwardedAid {
    if (
      (row.status !== 'awarded' && row.status !== 'partially_awarded') ||
      (row.award_kind !== 'fixed' && row.award_kind !== 'percent')
    )
      throw new Error('Stored aid award is invalid');
    return {
      applicationId: row.id,
      status: row.status,
      awardCents: row.award_cents,
      awardKind: row.award_kind,
      awardBps: row.award_bps,
      version: row.version,
    };
  }
}
