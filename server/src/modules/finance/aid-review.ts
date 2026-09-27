import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { decodeCursor, pageFromRows } from '../../lib/pagination.js';
import { appendAuditEvent } from '../audit/service.js';

export const aidQueueItemSchema = z.strictObject({
  id: z.uuid(),
  aidProgramId: z.uuid(),
  householdId: z.uuid(),
  programIds: z.array(z.uuid()),
  requestedCents: z.number().int().nonnegative(),
  status: z.enum(['submitted', 'under_review']),
  submittedAt: z.iso.datetime(),
  version: z.number().int().positive(),
});
export const aidQueueSchema = z.strictObject({
  applications: z.array(aidQueueItemSchema),
  nextCursor: z.string().nullable(),
});
export const aidDecisionBodySchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    action: z.enum(['start_review', 'decline']),
    reason: z
      .enum([
        'eligibility_not_met',
        'incomplete_application',
        'fund_exhausted',
        'other',
      ])
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.action === 'decline' && !value.reason)
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Decline reason is required',
      });
  });
export const aidDecisionResponseSchema = z.strictObject({
  applicationId: z.uuid(),
  status: z.enum(['under_review', 'declined']),
  version: z.number().int().positive(),
});
export type AidDecision = z.output<typeof aidDecisionResponseSchema>;
export class AidReviewConflictError extends Error {}

interface QueueRow {
  id: string;
  financial_aid_program_id: string;
  household_id: string;
  program_ids: string[];
  requested_cents: number;
  status: string;
  created_at: Date;
  created_at_cursor: string;
  version: number;
}

/** Lists only decision metadata; form answers and file payloads stay hidden. */
export class PostgresAidReview {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async queue(input: {
    seasonId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const season = input.seasonId ? z.uuid().parse(input.seasonId) : null;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new RangeError('Aid queue limit must be 1–100');
    const pageCursor = input.cursor
      ? decodeCursor(input.cursor, 'aid-created-desc')
      : null;
    const beforeDate = pageCursor
      ? z.iso.datetime().parse(pageCursor.value)
      : null;
    const beforeId = pageCursor?.id ?? null;
    return this.withOrg(this.context, async (trx) => {
      const result = await sql<QueueRow>`
        SELECT a.id, a.financial_aid_program_id, a.household_id,
          a.program_ids, a.requested_cents, a.status, a.created_at, a.version,
          to_char(a.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM aid_applications a
        JOIN financial_aid_programs f
          ON f.org_id = a.org_id AND f.id = a.financial_aid_program_id
        WHERE a.org_id = ${this.context.orgId}::uuid
          AND a.status IN ('submitted', 'under_review')
          AND (${season}::uuid IS NULL OR f.season_id = ${season}::uuid)
          AND (${beforeDate}::timestamptz IS NULL OR
            (a.created_at, a.id) <
              (${beforeDate}::timestamptz, ${beforeId}::uuid))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${input.limit + 1}
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'restricted.read',
        entityType: 'aid_application',
        entityId: this.context.orgId,
        changes: {
          requestedCents: { tier: 'restricted', after: '[read]' },
          householdId: { tier: 'restricted', after: '[read]' },
        },
      });
      const page = pageFromRows(result.rows, input.limit, (row) => ({
        sort: 'aid-created-desc',
        value: row.created_at_cursor,
        id: row.id,
      }));
      return aidQueueSchema.parse({
        applications: page.items.map((row) => ({
          id: row.id,
          aidProgramId: row.financial_aid_program_id,
          householdId: row.household_id,
          programIds: row.program_ids,
          requestedCents: row.requested_cents,
          status: row.status,
          submittedAt: row.created_at.toISOString(),
          version: row.version,
        })),
        nextCursor: page.nextCursor,
      });
    });
  }

  async decide(
    applicationId: string,
    input: z.output<typeof aidDecisionBodySchema>,
  ): Promise<AidDecision> {
    const id = z.uuid().parse(applicationId);
    const decision = aidDecisionBodySchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      const row = await trx
        .selectFrom('aid_applications')
        .select(['id', 'status', 'version', 'award_cents'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.version !== decision.expectedVersion ||
        row.award_cents !== 0 ||
        !['submitted', 'under_review'].includes(row.status)
      )
        throw new AidReviewConflictError('Aid application is not reviewable');
      if (decision.action === 'start_review' && row.status !== 'submitted')
        throw new AidReviewConflictError('Aid review already started');
      const status =
        decision.action === 'decline' ? 'declined' : 'under_review';
      const result = await sql<{ version: number }>`
        UPDATE aid_applications SET status = ${status},
          decision_reason = ${decision.action === 'decline' ? (decision.reason ?? null) : null},
          decided_by = ${decision.action === 'decline' ? this.context.actor.accountId : null}::uuid,
          version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${id}::uuid
        RETURNING version
      `.execute(trx);
      const updated = result.rows[0];
      if (!updated) throw new AidReviewConflictError('Aid application changed');
      await appendAuditEvent(trx, this.context, {
        action:
          decision.action === 'decline' ? 'aid.declined' : 'aid.review_started',
        entityType: 'aid_application',
        entityId: id,
        changes: {
          status: { tier: 'restricted', before: row.status, after: status },
          reason: { tier: 'restricted', after: decision.reason ?? null },
        },
      });
      return { applicationId: id, status, version: updated.version };
    });
  }
}
