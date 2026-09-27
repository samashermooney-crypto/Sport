import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import type { CheckoutCapacityRepository, SubjectQuantity } from './service.js';

const subjectOrder = { program: 0, division: 1, offering: 2 } as const;

function orderedSubjects(
  subjects: readonly SubjectQuantity[],
): SubjectQuantity[] {
  const ordered = [...subjects].sort(
    (a, b) =>
      subjectOrder[a.subject] - subjectOrder[b.subject] ||
      a.id.localeCompare(b.id),
  );
  if (
    !ordered.length ||
    new Set(ordered.map((s) => `${s.subject}:${s.id}`)).size !== ordered.length
  )
    throw new Error('Capacity subjects must be nonempty and distinct');
  if (ordered.some((s) => !Number.isSafeInteger(s.quantity) || s.quantity < 1))
    throw new RangeError('Capacity quantities must be positive integers');
  return ordered;
}

export class PostgresCheckoutHoldRepository implements Pick<
  CheckoutCapacityRepository,
  'reserve' | 'extend' | 'confirm' | 'release'
> {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async reserve(input: {
    orgId: string;
    checkoutId: string;
    subjects: readonly SubjectQuantity[];
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<'reserved' | 'already_reserved' | 'full'> {
    this.assertOrg(input.orgId);
    const subjects = orderedSubjects(input.subjects);
    const expiry = Temporal.Instant.from(input.expiresAt);
    if (Temporal.Instant.compare(expiry, this.now()) <= 0)
      throw new Error('Capacity hold expiry must be in the future');
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select('status')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!checkout || !['open', 'awaiting_payment'].includes(checkout.status))
        throw new Error('Checkout is unavailable for a capacity hold');
      const existing = await trx
        .selectFrom('capacity_holds')
        .select([
          'subject_type',
          'subject_id',
          'quantity',
          'released_at',
          'converted_at',
        ])
        .select(sql<string | null>`reservation_key`.as('reservation_key'))
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .execute();
      if (existing.length) {
        const same =
          existing.length === subjects.length &&
          subjects.every((subject, index) => {
            const hold = existing.find(
              (item) =>
                item.subject_type === subject.subject &&
                item.subject_id === subject.id,
            );
            return (
              index < subjects.length &&
              hold?.quantity === subject.quantity &&
              hold.reservation_key === input.idempotencyKey &&
              !hold.released_at &&
              !hold.converted_at
            );
          });
        if (!same)
          throw new Error(
            'Checkout capacity reservation conflicts with prior hold',
          );
        return 'already_reserved';
      }
      const counters = [];
      for (const subject of subjects) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['id', 'capacity', 'confirmed', 'held'])
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', subject.subject)
          .where('subject_id', '=', subject.id)
          .forUpdate()
          .executeTakeFirst();
        if (!counter) throw new Error('Capacity counter is missing');
        counters.push({ subject, counter });
      }
      if (
        counters.some(
          ({ subject, counter }) =>
            counter.capacity !== null &&
            counter.confirmed + counter.held + subject.quantity >
              counter.capacity,
        )
      )
        return 'full';
      for (const { subject, counter } of counters) {
        await trx
          .updateTable('capacity_counters')
          .set({
            held: sql`held + ${subject.quantity}`,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', counter.id)
          .execute();
        await sql`
          INSERT INTO capacity_holds
            (id, org_id, checkout_id, subject_type, subject_id, quantity,
             reservation_key, expires_at)
          VALUES
            (${newId()}::uuid, ${input.orgId}::uuid, ${input.checkoutId}::uuid,
             ${subject.subject}, ${subject.id}::uuid, ${subject.quantity},
             ${input.idempotencyKey}::uuid, ${new Date(expiry.epochMilliseconds)})
        `.execute(trx);
      }
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.capacity_reserved',
        entityType: 'checkout',
        entityId: input.checkoutId,
        changes: { seats: { tier: 'internal', after: subjects.length } },
      });
      return 'reserved';
    });
  }

  async extend(input: {
    orgId: string;
    checkoutId: string;
    expiresAt: string;
  }): Promise<boolean> {
    this.assertOrg(input.orgId);
    const expiry = Temporal.Instant.from(input.expiresAt);
    if (Temporal.Instant.compare(expiry, this.now()) <= 0) return false;
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select('status')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!checkout || !['open', 'awaiting_payment'].includes(checkout.status))
        return false;
      const holds = await trx
        .selectFrom('capacity_holds')
        .select(['id', 'expires_at', 'released_at', 'converted_at'])
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .forUpdate()
        .execute();
      if (
        !holds.length ||
        holds.some(
          (hold) =>
            hold.released_at ||
            hold.converted_at ||
            hold.expires_at.getTime() <= this.now().epochMilliseconds,
        )
      )
        return false;
      await trx
        .updateTable('capacity_holds')
        .set({ expires_at: new Date(expiry.epochMilliseconds) })
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .execute();
      await trx
        .updateTable('checkouts')
        .set({ expires_at: new Date(expiry.epochMilliseconds) })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .execute();
      return true;
    });
  }

  async confirm(input: {
    orgId: string;
    checkoutId: string;
    honorProcessingHold: boolean;
  }): Promise<'confirmed' | 'already_confirmed' | 'expired'> {
    this.assertOrg(input.orgId);
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select('status')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!checkout) throw new Error('Checkout not found');
      if (checkout.status === 'completed') return 'already_confirmed';
      if (checkout.status !== 'awaiting_payment') return 'expired';
      const holds = await trx
        .selectFrom('capacity_holds')
        .select([
          'id',
          'subject_type',
          'subject_id',
          'quantity',
          'expires_at',
          'released_at',
          'converted_at',
        ])
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .execute();
      if (
        !holds.length ||
        holds.some((hold) => hold.released_at || hold.converted_at)
      )
        return 'expired';
      const ordered = [...holds].sort(
        (a, b) =>
          subjectOrder[a.subject_type as keyof typeof subjectOrder] -
            subjectOrder[b.subject_type as keyof typeof subjectOrder] ||
          a.subject_id.localeCompare(b.subject_id),
      );
      const counters = [];
      for (const hold of ordered) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['id', 'held'])
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', hold.subject_type)
          .where('subject_id', '=', hold.subject_id)
          .forUpdate()
          .executeTakeFirst();
        if (!counter || counter.held < hold.quantity)
          throw new Error('Capacity hold does not reconcile');
        counters.push({ hold, counter });
      }
      if (
        !input.honorProcessingHold &&
        holds.some(
          (hold) => hold.expires_at.getTime() <= this.now().epochMilliseconds,
        )
      )
        return 'expired';
      for (const { hold, counter } of counters) {
        await trx
          .updateTable('capacity_counters')
          .set({
            held: sql`held - ${hold.quantity}`,
            confirmed: sql`confirmed + ${hold.quantity}`,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', counter.id)
          .execute();
      }
      await trx
        .updateTable('capacity_holds')
        .set({ converted_at: new Date(this.now().epochMilliseconds) })
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .execute();
      await trx
        .updateTable('checkouts')
        .set({
          status: 'completed',
          completed_at: new Date(this.now().epochMilliseconds),
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .execute();
      await trx
        .updateTable('registrations')
        .set({ status: 'confirmed', version: sql`version + 1` })
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .where('status', '=', 'pending_payment')
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.confirmed',
        entityType: 'checkout',
        entityId: input.checkoutId,
        changes: {
          status: {
            tier: 'internal',
            before: checkout.status,
            after: 'completed',
          },
        },
      });
      return 'confirmed';
    });
  }

  async release(input: { orgId: string; checkoutId: string }): Promise<void> {
    this.assertOrg(input.orgId);
    await this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select('status')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!checkout || checkout.status === 'completed') return;
      const holds = await trx
        .selectFrom('capacity_holds')
        .select([
          'subject_type',
          'subject_id',
          'quantity',
          'released_at',
          'converted_at',
        ])
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .execute();
      const ordered = [...holds].sort(
        (a, b) =>
          subjectOrder[a.subject_type as keyof typeof subjectOrder] -
            subjectOrder[b.subject_type as keyof typeof subjectOrder] ||
          a.subject_id.localeCompare(b.subject_id),
      );
      for (const hold of ordered) {
        if (hold.released_at || hold.converted_at) continue;
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['id', 'held'])
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', hold.subject_type)
          .where('subject_id', '=', hold.subject_id)
          .forUpdate()
          .executeTakeFirst();
        if (!counter || counter.held < hold.quantity)
          throw new Error('Capacity hold does not reconcile');
        await trx
          .updateTable('capacity_counters')
          .set({
            held: sql`held - ${hold.quantity}`,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', counter.id)
          .execute();
      }
      await trx
        .updateTable('capacity_holds')
        .set({ released_at: new Date(this.now().epochMilliseconds) })
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .where('released_at', 'is', null)
        .where('converted_at', 'is', null)
        .execute();
      await trx
        .updateTable('checkouts')
        .set({ status: 'expired', version: sql`version + 1` })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .execute();
    });
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId)
      throw new Error('Checkout organization mismatch');
  }
}
