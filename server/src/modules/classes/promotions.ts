import { Temporal } from '@js-temporal/polyfill';
import { tierChangeAdjustment } from '@shared/algorithms/proration';
import { newId } from '@shared/ids';
import type { Promotion } from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { requireVersion } from '../../lib/version-check.js';
import { appendAuditEvent } from '../audit/service.js';
import { createNotification } from '../notifications/service.js';

import { PostgresClassEnrollments } from './enrollments.js';
import { sessionDatesInRange } from './enrollments.js';
import { ClassesConflictError, ClassesNotFoundError } from './errors.js';
import {
  issueCreditInTransaction,
  issueInvoiceInTransaction,
} from './invoice-writer.js';

interface PromotionRow {
  id: string;
  person_id: string;
  first_name: string;
  last_name: string;
  from_level_id: string | null;
  from_level_name: string | null;
  to_level_id: string;
  to_level_name: string;
  status: string;
  note: string | null;
  recommended_at: Date;
  decided_at: Date | null;
  target_class_offering_id: string | null;
  version: number;
}

const PROMOTION_SELECT = `
  SELECT promotion.id, promotion.person_id,
    person.first_name, person.last_name,
    promotion.from_level_id, from_level.name AS from_level_name,
    promotion.to_level_id, to_level.name AS to_level_name,
    promotion.status, promotion.note, promotion.recommended_at,
    promotion.decided_at, promotion.target_class_offering_id,
    promotion.version
  FROM level_promotions promotion
  JOIN people person ON person.org_id = promotion.org_id
    AND person.id = promotion.person_id
  LEFT JOIN skill_levels from_level ON from_level.org_id = promotion.org_id
    AND from_level.id = promotion.from_level_id
  JOIN skill_levels to_level ON to_level.org_id = promotion.org_id
    AND to_level.id = promotion.to_level_id
`;

function mapPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    personId: row.person_id,
    personName: `${row.first_name} ${row.last_name}`,
    fromLevelId: row.from_level_id,
    fromLevelName: row.from_level_name,
    toLevelId: row.to_level_id,
    toLevelName: row.to_level_name,
    status: row.status as Promotion['status'],
    note: row.note,
    recommendedAt: row.recommended_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    targetClassOfferingId: row.target_class_offering_id,
    version: row.version,
  };
}

export class PostgresClassPromotions {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async list(input: {
    personId?: string;
    accountId?: string;
    status?: string;
    limit: number;
  }): Promise<Promotion[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<PromotionRow>`
        ${sql.raw(PROMOTION_SELECT)}
        WHERE promotion.org_id = ${this.context.orgId}::uuid
          ${input.personId ? sql`AND promotion.person_id = ${input.personId}::uuid` : sql``}
          ${input.status ? sql`AND promotion.status = ${input.status}` : sql``}
          ${
            input.accountId
              ? sql`AND EXISTS (
                SELECT 1 FROM person_account_links link
                WHERE link.org_id = promotion.org_id
                  AND link.person_id = promotion.person_id
                  AND link.account_id = ${input.accountId}::uuid
                  AND link.verified_at IS NOT NULL
                  AND link.revoked_at IS NULL
              )`
              : sql``
          }
        ORDER BY promotion.created_at DESC
        LIMIT ${input.limit}
      `.execute(trx);
      return rows.rows.map(mapPromotion);
    });
  }

  private async getInTransaction(
    trx: OrgTransaction,
    promotionId: string,
  ): Promise<Promotion> {
    const rows = await sql<PromotionRow>`
      ${sql.raw(PROMOTION_SELECT)}
      WHERE promotion.org_id = ${this.context.orgId}::uuid
        AND promotion.id = ${promotionId}::uuid
    `.execute(trx);
    const row = rows.rows[0];
    if (!row) throw new ClassesNotFoundError('Promotion not found');
    return mapPromotion(row);
  }

  async get(promotionId: string): Promise<Promotion> {
    return this.withOrg(this.context, (trx) =>
      this.getInTransaction(trx, promotionId),
    );
  }

  /** Instructor/staff recommends moving an athlete up a level. */
  async recommend(input: {
    personId: string;
    toLevelId: string;
    note?: string | null;
    targetClassOfferingId?: string | null;
  }): Promise<Promotion> {
    return this.withOrg(this.context, async (trx) => {
      const person = await trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', input.personId)
        .executeTakeFirst();
      if (!person) throw new ClassesNotFoundError('Person not found');
      const target = await trx
        .selectFrom('skill_levels')
        .select(['id', 'sport_profile_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', input.toLevelId)
        .executeTakeFirst();
      if (!target) throw new ClassesNotFoundError('Target level not found');
      const current = await trx
        .selectFrom('level_promotions')
        .select(['to_level_id'])
        .where('org_id', '=', this.context.orgId)
        .where('person_id', '=', input.personId)
        .where('status', '=', 'completed')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const enrollment = await trx
        .selectFrom('class_enrollments as enrollment')
        .innerJoin('class_offerings as offering', (join) =>
          join
            .onRef('offering.org_id', '=', 'enrollment.org_id')
            .onRef('offering.id', '=', 'enrollment.class_offering_id'),
        )
        .select(['enrollment.id', 'offering.skill_level_id'])
        .where('enrollment.org_id', '=', this.context.orgId)
        .where('enrollment.person_id', '=', input.personId)
        .where('enrollment.status', 'in', ['trial', 'active', 'paused'])
        .executeTakeFirst();
      const fromLevelId =
        current?.to_level_id ?? enrollment?.skill_level_id ?? null;
      if (fromLevelId === input.toLevelId)
        throw new ClassesConflictError('Already at this level');
      if (input.targetClassOfferingId) {
        const offering = await trx
          .selectFrom('class_offerings')
          .select(['id', 'skill_level_id', 'status'])
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', input.targetClassOfferingId)
          .executeTakeFirst();
        if (!offering || offering.status !== 'active')
          throw new ClassesNotFoundError('Target class not found');
        if (offering.skill_level_id !== input.toLevelId)
          throw new ClassesConflictError('Target class is not for that level');
      }
      const id = newId();
      await trx
        .insertInto('level_promotions')
        .values({
          id,
          org_id: this.context.orgId,
          person_id: input.personId,
          from_level_id: fromLevelId,
          to_level_id: input.toLevelId,
          status: 'recommended',
          recommended_by: this.context.actor.accountId,
          note: input.note ?? null,
          source_enrollment_id: enrollment?.id ?? null,
          target_class_offering_id: input.targetClassOfferingId ?? null,
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.promotion_recommended',
        entityType: 'level_promotion',
        entityId: id,
        changes: {
          personId: { tier: 'restricted', after: input.personId },
          toLevelId: { tier: 'internal', after: input.toLevelId },
        },
      });
      return this.getInTransaction(trx, id);
    });
  }

  /** Staff approves a recommendation — family is asked to confirm. */
  async approve(
    promotionId: string,
    expectedVersion: number,
  ): Promise<Promotion> {
    return this.withOrg(this.context, async (trx) => {
      const row = await this.lock(trx, promotionId, expectedVersion);
      if (row.status !== 'recommended')
        throw new ClassesConflictError('Promotion is not awaiting approval');
      await trx
        .updateTable('level_promotions')
        .set({ status: 'approved', version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', promotionId)
        .execute();
      const accounts = await trx
        .selectFrom('person_account_links')
        .select('account_id')
        .where('org_id', '=', this.context.orgId)
        .where('person_id', '=', row.person_id)
        .where('relationship', '=', 'guardian')
        .where('verified_at', 'is not', null)
        .where('revoked_at', 'is', null)
        .execute();
      for (const account of accounts) {
        await createNotification(trx, this.context, {
          accountId: account.account_id,
          type: 'registration.offered',
          payload: {
            resourceType: 'level_promotion',
            resourceId: promotionId,
            personId: row.person_id,
            href: `/me/orgs/${this.context.orgId}/classes`,
          },
        });
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.promotion_approved',
        entityType: 'level_promotion',
        entityId: promotionId,
        changes: {},
      });
      return this.getInTransaction(trx, promotionId);
    });
  }

  private async lock(
    trx: OrgTransaction,
    promotionId: string,
    expectedVersion: number,
  ) {
    const row = await trx
      .selectFrom('level_promotions')
      .selectAll()
      .where('org_id', '=', this.context.orgId)
      .where('id', '=', promotionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new ClassesNotFoundError('Promotion not found');
    requireVersion(row, expectedVersion);
    return row;
  }

  /** Guardian confirms — moves the enrollment into the next-level class. */
  async confirm(
    promotionId: string,
    input: {
      expectedVersion: number;
      targetClassOfferingId?: string | null;
    },
    operationKey: string,
  ): Promise<Promotion> {
    return this.withOrg(this.context, async (trx) => {
      const row = await this.lock(trx, promotionId, input.expectedVersion);
      if (!['recommended', 'approved'].includes(row.status))
        throw new ClassesConflictError('Promotion is not open for confirm');
      const targetOfferingId =
        input.targetClassOfferingId ?? row.target_class_offering_id;
      let newEnrollmentId: string | null = null;
      if (row.source_enrollment_id && targetOfferingId) {
        const source = await trx
          .selectFrom('class_enrollments')
          .selectAll()
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', row.source_enrollment_id)
          .forUpdate()
          .executeTakeFirst();
        if (source && ['trial', 'active', 'paused'].includes(source.status)) {
          const org = await trx
            .selectFrom('organizations')
            .select('timezone')
            .where('id', '=', this.context.orgId)
            .executeTakeFirstOrThrow();
          const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: org.timezone,
          }).format(new Date());
          const enrollments = new PostgresClassEnrollments(
            this.database,
            this.context,
          );
          const targetOffering = await trx
            .selectFrom('class_offerings')
            .select(['billing', 'name'])
            .where('org_id', '=', this.context.orgId)
            .where('id', '=', targetOfferingId)
            .executeTakeFirst();
          if (
            !targetOffering ||
            targetOffering.billing === 'drop_in' ||
            targetOffering.billing === 'punch_card'
          )
            throw new ClassesConflictError(
              'The promoted level must have an ongoing class offering',
            );
          const oldHouseholdMonthlyCents = source.billing_subscription_id
            ? await enrollments.householdMonthlyCents(
                trx,
                source.household_id,
                null,
              )
            : null;
          await trx
            .updateTable('class_enrollments')
            .set({
              status: 'ended',
              ends_on: today,
              version: sql`version + 1`,
              updated_at: sql`now()`,
            })
            .where('org_id', '=', this.context.orgId)
            .where('id', '=', source.id)
            .execute();
          const result = await enrollments.enrollInTransaction(
            trx,
            {
              classOfferingId: targetOfferingId,
              personId: row.person_id,
              householdId: source.household_id,
              startsOn: today,
              classesPerWeek: source.classes_per_week,
              trial: false,
              trialSessionId: null,
              paymentMethodId: null,
              autopay: false,
              billingDay: 1,
            },
            operationKey,
            {
              staff: true,
              skipInitialTuition:
                Boolean(source.billing_subscription_id) &&
                targetOffering.billing === 'monthly',
            },
          );
          if (!result.enrollment)
            throw new ClassesConflictError(
              'The target class could not take the enrollment',
            );
          newEnrollmentId = result.enrollment.id;

          // A level change on an existing monthly subscription must not charge
          // the target class's full first month again. Default changes take
          // effect on the next invoice; immediate changes settle only the
          // session-based difference for the remainder of this month.
          if (
            source.billing_subscription_id &&
            result.enrollment.billingSubscriptionId ===
              source.billing_subscription_id
          ) {
            const subscription = await trx
              .selectFrom('tuition_subscriptions')
              .select(['tier_change_mode', 'account_id', 'household_id'])
              .where('org_id', '=', this.context.orgId)
              .where('id', '=', source.billing_subscription_id)
              .executeTakeFirst();
            if (subscription?.tier_change_mode === 'immediate') {
              const target = await trx
                .selectFrom('class_offerings')
                .select(['price_cents', 'name'])
                .where('org_id', '=', this.context.orgId)
                .where('id', '=', targetOfferingId)
                .executeTakeFirstOrThrow();
              const sourceOffering = await trx
                .selectFrom('class_offerings')
                .select(['price_cents'])
                .where('org_id', '=', this.context.orgId)
                .where('id', '=', source.class_offering_id)
                .executeTakeFirstOrThrow();
              const month = monthBounds(today);
              const sessions = await sessionDatesInRange(
                trx,
                this.context.orgId,
                targetOfferingId,
                month.start,
                month.end,
              );
              const newHouseholdMonthlyCents =
                await enrollments.householdMonthlyCents(
                  trx,
                  source.household_id,
                  null,
                );
              const delta = tierChangeAdjustment(
                oldHouseholdMonthlyCents ?? sourceOffering.price_cents,
                newHouseholdMonthlyCents,
                sessions,
                today,
                'immediate',
              );
              if (delta > 0) {
                const invoice = await issueInvoiceInTransaction(
                  trx,
                  this.context,
                  {
                    orgId: this.context.orgId,
                    accountId: subscription.account_id,
                    householdId: subscription.household_id,
                    source: 'tuition',
                    memo: `${target.name} — level change`,
                    creationKey: deterministicPromotionKey(promotionId),
                    dueOn: today,
                    lines: [
                      {
                        kind: 'tuition',
                        description: `${target.name} — level change proration`,
                        amountCents: delta,
                        refundable: true,
                      },
                    ],
                  },
                );
                await enrollments.attachAutopayInstallment(
                  trx,
                  source.billing_subscription_id,
                  invoice.id,
                  invoice.totalCents,
                  today,
                  operationKey,
                );
              } else if (delta < 0) {
                await issueCreditInTransaction(trx, this.context, {
                  householdId: subscription.household_id,
                  amountCents: -delta,
                  source: 'class_level_change',
                  note: `Session-based tuition adjustment for ${target.name}`,
                  operationKey,
                });
              }
            }
          }
        }
      }
      await trx
        .updateTable('level_promotions')
        .set({
          status: 'completed',
          decided_by_account_id: this.context.actor.accountId,
          decided_at: sql`now()`,
          target_enrollment_id: newEnrollmentId,
          certificate_issued_at: sql`now()`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', promotionId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.promotion_completed',
        entityType: 'level_promotion',
        entityId: promotionId,
        changes: {
          targetEnrollmentId: { tier: 'internal', after: newEnrollmentId },
        },
      });
      return this.getInTransaction(trx, promotionId);
    });
  }

  async decline(
    promotionId: string,
    expectedVersion: number,
  ): Promise<Promotion> {
    return this.withOrg(this.context, async (trx) => {
      await this.lock(trx, promotionId, expectedVersion);
      await trx
        .updateTable('level_promotions')
        .set({
          status: 'declined',
          decided_by_account_id: this.context.actor.accountId,
          decided_at: sql`now()`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', promotionId)
        .execute();
      return this.getInTransaction(trx, promotionId);
    });
  }

  async cancel(
    promotionId: string,
    expectedVersion: number,
  ): Promise<Promotion> {
    return this.withOrg(this.context, async (trx) => {
      const row = await this.lock(trx, promotionId, expectedVersion);
      if (!['recommended', 'approved'].includes(row.status))
        throw new ClassesConflictError('Promotion is already decided');
      await trx
        .updateTable('level_promotions')
        .set({
          status: 'canceled',
          decided_by_account_id: this.context.actor.accountId,
          decided_at: sql`now()`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', promotionId)
        .execute();
      return this.getInTransaction(trx, promotionId);
    });
  }

  /** Certificate PDF for a completed promotion. */
  async certificatePdf(promotionId: string): Promise<Uint8Array> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<{
        person_name: string;
        to_level_name: string;
        org_name: string;
        decided_at: Date | null;
        status: string;
        recommended_by_name: string | null;
      }>`
        SELECT person.first_name || ' ' || person.last_name AS person_name,
          level.name AS to_level_name, org.name AS org_name,
          promotion.decided_at, promotion.status,
          account.first_name || ' ' || account.last_name AS recommended_by_name
        FROM level_promotions promotion
        JOIN people person ON person.org_id = promotion.org_id
          AND person.id = promotion.person_id
        JOIN skill_levels level ON level.org_id = promotion.org_id
          AND level.id = promotion.to_level_id
        JOIN organizations org ON org.id = promotion.org_id
        LEFT JOIN accounts account
          ON account.id = promotion.recommended_by
        WHERE promotion.org_id = ${this.context.orgId}::uuid
          AND promotion.id = ${promotionId}::uuid
      `.execute(trx);
      const row = rows.rows[0];
      if (!row) throw new ClassesNotFoundError('Promotion not found');
      if (row.status !== 'completed')
        throw new ClassesConflictError(
          'Certificate is available after the move is complete',
        );
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([792, 612]);
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);
      const body = await pdf.embedFont(StandardFonts.Helvetica);
      const date = row.decided_at
        ? Temporal.Instant.from(row.decided_at.toISOString())
            .toZonedDateTimeISO('UTC')
            .toPlainDate()
            .toString()
        : '';
      page.drawText('Certificate of Achievement', {
        x: 96,
        y: 460,
        size: 36,
        font,
      });
      page.drawText('This certifies that', {
        x: 96,
        y: 390,
        size: 18,
        font: body,
      });
      page.drawText(row.person_name, { x: 96, y: 340, size: 30, font });
      page.drawText(`has been promoted to ${row.to_level_name}`, {
        x: 96,
        y: 290,
        size: 18,
        font: body,
      });
      page.drawText(`Awarded by ${row.org_name} on ${date}`, {
        x: 96,
        y: 240,
        size: 14,
        font: body,
      });
      if (row.recommended_by_name)
        page.drawText(`Instructor: ${row.recommended_by_name}`, {
          x: 96,
          y: 214,
          size: 12,
          font: body,
        });
      return pdf.save();
    });
  }
}

function monthBounds(containing: string): { start: string; end: string } {
  const date = Temporal.PlainDate.from(containing);
  const start = new Temporal.PlainDate(date.year, date.month, 1);
  return {
    start: start.toString(),
    end: start.add({ months: 1 }).subtract({ days: 1 }).toString(),
  };
}

function deterministicPromotionKey(promotionId: string): string {
  // creationKey must be a UUID; derive a deterministic one from the promotion id.
  const hex = promotionId.replaceAll('-', '');
  return `${hex.slice(0, 8)}-1fff-8fff-ffff-${hex.slice(20, 32)}`;
}
