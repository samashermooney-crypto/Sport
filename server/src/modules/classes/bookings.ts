import { newId } from '@shared/ids';
import type {
  BookingResult,
  MakeupCredit,
  PunchCard,
} from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import type { NewInvoiceLine } from '../finance/invoices.js';

import { dateOnly } from './enrollments.js';
import {
  ClassesConflictError,
  ClassesNotFoundError,
  MakeupCreditError,
  SessionFullError,
} from './errors.js';
import { issueInvoiceInTransaction } from './invoice-writer.js';

const makeupPolicySchema = z.strictObject({
  creditsPerTerm: z.number().int().nonnegative().default(0),
  expiryDays: z.number().int().positive().default(90),
  eligibleLevelIds: z.array(z.uuid()).nullable().default(null),
  eligibleOfferingIds: z.array(z.uuid()).nullable().default(null),
});

async function loadSessionForBooking(
  trx: OrgTransaction,
  orgId: string,
  classSessionId: string,
): Promise<{
  session_id: string;
  event_id: string;
  offering_id: string;
  offering_name: string;
  billing: string;
  price_cents: number;
  capacity: number;
  status: string;
  event_date: string;
  enrolled_count: number;
  booked_count: number;
  skill_level_id: string | null;
}> {
  const rows = await sql<{
    session_id: string;
    event_id: string;
    offering_id: string;
    offering_name: string;
    billing: string;
    price_cents: number;
    capacity: number;
    status: string;
    event_date: string;
    enrolled_count: number;
    booked_count: number;
    skill_level_id: string | null;
  }>`
    SELECT session.id AS session_id, session.event_id,
      session.class_offering_id AS offering_id, offering.name AS offering_name,
      offering.billing, offering.price_cents,
      COALESCE(session.capacity, offering.capacity)::integer AS capacity,
      event.status,
      (event.starts_at AT TIME ZONE event.timezone)::date::text AS event_date,
      offering.skill_level_id,
      (SELECT count(*)::integer FROM class_enrollments e
        WHERE e.org_id = session.org_id
          AND e.class_offering_id = session.class_offering_id
          AND e.status IN ('trial', 'active')
          AND e.starts_on <= (event.starts_at AT TIME ZONE event.timezone)::date
          AND (e.ends_on IS NULL OR e.ends_on >=
            (event.starts_at AT TIME ZONE event.timezone)::date)
          AND (e.pause_from IS NULL OR e.pause_to IS NULL
            OR (event.starts_at AT TIME ZONE event.timezone)::date
              NOT BETWEEN e.pause_from AND e.pause_to)) AS enrolled_count,
      (SELECT count(*)::integer FROM class_session_bookings b
        WHERE b.org_id = session.org_id AND b.class_session_id = session.id
          AND b.status IN ('booked', 'attended')) AS booked_count
    FROM class_sessions session
    JOIN events event ON event.org_id = session.org_id
      AND event.id = session.event_id
    JOIN class_offerings offering ON offering.org_id = session.org_id
      AND offering.id = session.class_offering_id
    WHERE session.org_id = ${orgId}::uuid
      AND session.id = ${classSessionId}::uuid
    FOR UPDATE OF session
  `.execute(trx);
  const row = rows.rows[0];
  if (!row) throw new ClassesNotFoundError('Class session not found');
  return row;
}

function assertBookable(session: {
  status: string;
  event_date: string;
  enrolled_count: number;
  booked_count: number;
  capacity: number;
}): void {
  if (session.status !== 'scheduled')
    throw new ClassesConflictError('This session is not scheduled');
  if (session.enrolled_count + session.booked_count >= session.capacity)
    throw new SessionFullError();
}

export class PostgresClassBookings {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  /** Drop-in purchase: books one session, invoices at the drop-in price. */
  async bookDropIn(
    classSessionId: string,
    personId: string,
    householdId: string,
    operationKey: string,
  ): Promise<BookingResult> {
    return this.withOrg(this.context, async (trx) => {
      const replay = await trx
        .selectFrom('class_session_bookings')
        .select(['id', 'invoice_id', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('creation_key', '=', operationKey)
        .executeTakeFirst();
      if (replay)
        return {
          bookingId: replay.id,
          invoiceId: replay.invoice_id,
          amountDueCents: null,
          status: replay.status as BookingResult['status'],
        };
      const session = await loadSessionForBooking(
        trx,
        this.context.orgId,
        classSessionId,
      );
      if (session.billing !== 'drop_in')
        throw new ClassesConflictError('This class does not take drop-ins');
      assertBookable(session);
      const duplicate = await trx
        .selectFrom('class_session_bookings')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('class_session_id', '=', classSessionId)
        .where('person_id', '=', personId)
        .where('status', 'in', ['booked', 'attended'])
        .executeTakeFirst();
      if (duplicate)
        throw new ClassesConflictError('Already booked for this session');
      const enrollment = await trx
        .selectFrom('class_enrollments')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('class_offering_id', '=', session.offering_id)
        .where('person_id', '=', personId)
        .where('status', 'in', ['trial', 'active', 'paused'])
        .executeTakeFirst();
      if (enrollment)
        throw new ClassesConflictError(
          'Enrolled athletes do not need a drop-in booking',
        );

      let invoiceId: string | null = null;
      let amountDue: number | null = null;
      const id = newId();
      if (session.price_cents > 0) {
        const lines: NewInvoiceLine[] = [
          {
            kind: 'tuition',
            description: `${session.offering_name} — drop-in class ${session.event_date}`,
            amountCents: session.price_cents,
            refundable: false,
          },
        ];
        const invoice = await issueInvoiceInTransaction(trx, this.context, {
          orgId: this.context.orgId,
          accountId: this.context.actor.accountId,
          householdId,
          source: 'tuition',
          memo: `${session.offering_name} drop-in`,
          creationKey: operationKey,
          dueOn: session.event_date,
          lines,
        });
        invoiceId = invoice.id;
        amountDue = invoice.totalCents;
      }
      await trx
        .insertInto('class_session_bookings')
        .values({
          id,
          org_id: this.context.orgId,
          class_session_id: classSessionId,
          person_id: personId,
          household_id: householdId,
          account_id: this.context.actor.accountId,
          kind: 'drop_in',
          invoice_id: invoiceId,
          status: 'booked',
          creation_key: operationKey,
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.drop_in_booked',
        entityType: 'class_session_booking',
        entityId: id,
        changes: {},
      });
      return {
        bookingId: id,
        invoiceId,
        amountDueCents: amountDue,
        status: 'booked',
      };
    });
  }

  /** Spend a make-up credit on a session the policy permits. */
  async bookMakeup(
    creditId: string,
    classSessionId: string,
  ): Promise<BookingResult> {
    return this.withOrg(this.context, async (trx) => {
      const credit = await trx
        .selectFrom('makeup_credits')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', creditId)
        .forUpdate()
        .executeTakeFirst();
      if (!credit) throw new MakeupCreditError();
      if (credit.status !== 'available') throw new MakeupCreditError();
      const session = await loadSessionForBooking(
        trx,
        this.context.orgId,
        classSessionId,
      );
      if (session.event_date > dateOnly(credit.expires_on))
        throw new MakeupCreditError('The session is after the credit expiry');
      const sourceOffering = await trx
        .selectFrom('class_offerings')
        .select(['makeup_policy', 'skill_level_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', credit.class_offering_id)
        .executeTakeFirstOrThrow();
      const policy = makeupPolicySchema.parse(
        sourceOffering.makeup_policy ?? {},
      );
      const offeringOk =
        policy.eligibleOfferingIds === null ||
        policy.eligibleOfferingIds.includes(session.offering_id);
      const levelOk =
        policy.eligibleLevelIds === null ||
        (session.skill_level_id !== null &&
          policy.eligibleLevelIds.includes(session.skill_level_id));
      if (!offeringOk || !levelOk)
        throw new MakeupCreditError(
          'This class is not eligible for the credit',
        );
      assertBookable(session);
      const duplicate = await trx
        .selectFrom('class_session_bookings')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('class_session_id', '=', classSessionId)
        .where('person_id', '=', credit.person_id)
        .where('status', 'in', ['booked', 'attended'])
        .executeTakeFirst();
      if (duplicate)
        throw new ClassesConflictError('Already booked for this session');
      const id = newId();
      await trx
        .updateTable('makeup_credits')
        .set({
          status: 'used',
          used_event_id: session.event_id,
          used_at: sql`now()`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', creditId)
        .execute();
      await trx
        .insertInto('class_session_bookings')
        .values({
          id,
          org_id: this.context.orgId,
          class_session_id: classSessionId,
          person_id: credit.person_id,
          household_id: await this.personHousehold(trx, credit.person_id),
          account_id: this.context.actor.accountId,
          kind: 'makeup',
          makeup_credit_id: creditId,
          status: 'booked',
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.makeup_booked',
        entityType: 'makeup_credit',
        entityId: creditId,
        changes: {
          eventId: { tier: 'internal', after: session.event_id },
        },
      });
      return {
        bookingId: id,
        invoiceId: null,
        amountDueCents: null,
        status: 'booked',
      };
    });
  }

  private async personHousehold(
    trx: OrgTransaction,
    personId: string,
  ): Promise<string> {
    const member = await trx
      .selectFrom('household_members')
      .select('household_id')
      .where('org_id', '=', this.context.orgId)
      .where('person_id', '=', personId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    if (!member) throw new ClassesNotFoundError('Household not found');
    return member.household_id;
  }

  /** Purchase a punch card: invoices the pack price and creates the card. */
  async purchasePunchCard(
    classOfferingId: string,
    personId: string,
    householdId: string,
    operationKey: string,
  ): Promise<{ punchCardId: string; invoiceId: string; amountCents: number }> {
    return this.withOrg(this.context, async (trx) => {
      const replay = await trx
        .selectFrom('punch_cards')
        .select(['id', 'invoice_id'])
        .where('org_id', '=', this.context.orgId)
        .where('creation_key', '=', operationKey)
        .executeTakeFirst();
      if (replay)
        return {
          punchCardId: replay.id,
          invoiceId: replay.invoice_id,
          amountCents: 0,
        };
      const offering = await trx
        .selectFrom('class_offerings')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', classOfferingId)
        .forUpdate()
        .executeTakeFirst();
      if (!offering || offering.status !== 'active')
        throw new ClassesNotFoundError('Class offering not found');
      if (offering.billing !== 'punch_card' || !offering.punch_card_uses)
        throw new ClassesConflictError('This class does not offer punch cards');
      const lines: NewInvoiceLine[] = [
        {
          kind: 'tuition',
          description: `${offering.name} — punch card (${String(offering.punch_card_uses)} classes)`,
          amountCents: offering.price_cents,
          refundable: true,
        },
      ];
      const invoice = await issueInvoiceInTransaction(trx, this.context, {
        orgId: this.context.orgId,
        accountId: this.context.actor.accountId,
        householdId,
        source: 'tuition',
        memo: `${offering.name} punch card`,
        creationKey: operationKey,
        lines,
      });
      const id = newId();
      await trx
        .insertInto('punch_cards')
        .values({
          id,
          org_id: this.context.orgId,
          account_id: this.context.actor.accountId,
          household_id: householdId,
          person_id: personId,
          class_offering_id: classOfferingId,
          total_uses: offering.punch_card_uses,
          remaining_uses: offering.punch_card_uses,
          invoice_id: invoice.id,
          status: 'active',
          creation_key: operationKey,
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.punch_card_purchased',
        entityType: 'punch_card',
        entityId: id,
        changes: {},
      });
      return {
        punchCardId: id,
        invoiceId: invoice.id,
        amountCents: invoice.totalCents,
      };
    });
  }

  /** Redeem one punch on a session. */
  async bookPunchCard(
    classSessionId: string,
    punchCardId: string,
  ): Promise<BookingResult> {
    return this.withOrg(this.context, async (trx) => {
      const card = await trx
        .selectFrom('punch_cards')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', punchCardId)
        .forUpdate()
        .executeTakeFirst();
      if (!card || card.status !== 'active')
        throw new ClassesNotFoundError('Punch card not found');
      if (card.remaining_uses < 1)
        throw new ClassesConflictError(
          'Punch card is exhausted',
          'PUNCH_CARD_EXHAUSTED',
        );
      if (card.expires_on && dateOnly(card.expires_on) < dateOnly(new Date()))
        throw new ClassesConflictError('Punch card expired');
      const session = await loadSessionForBooking(
        trx,
        this.context.orgId,
        classSessionId,
      );
      if (session.offering_id !== card.class_offering_id)
        throw new ClassesConflictError('Punch card is for a different class');
      assertBookable(session);
      const remaining = card.remaining_uses - 1;
      await trx
        .updateTable('punch_cards')
        .set({
          remaining_uses: remaining,
          status: remaining === 0 ? 'exhausted' : 'active',
          version: sql`version + 1`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', punchCardId)
        .execute();
      const id = newId();
      await trx
        .insertInto('class_session_bookings')
        .values({
          id,
          org_id: this.context.orgId,
          class_session_id: classSessionId,
          person_id: card.person_id,
          household_id: card.household_id,
          account_id: this.context.actor.accountId,
          kind: 'drop_in',
          punch_card_id: punchCardId,
          status: 'booked',
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.punch_redeemed',
        entityType: 'punch_card',
        entityId: punchCardId,
        changes: { remainingUses: { tier: 'internal', after: remaining } },
      });
      return {
        bookingId: id,
        invoiceId: null,
        amountDueCents: null,
        status: 'booked',
      };
    });
  }

  async cancelBooking(bookingId: string): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const booking = await trx
        .selectFrom('class_session_bookings')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', bookingId)
        .forUpdate()
        .executeTakeFirst();
      if (!booking || booking.status !== 'booked')
        throw new ClassesNotFoundError('Booking not found');
      await trx
        .updateTable('class_session_bookings')
        .set({ status: 'canceled', version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', bookingId)
        .execute();
      if (booking.makeup_credit_id) {
        await trx
          .updateTable('makeup_credits')
          .set({
            status: 'available',
            used_event_id: null,
            used_at: null,
            version: sql`version + 1`,
          })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', booking.makeup_credit_id)
          .where('status', '=', 'used')
          .execute();
      }
      if (booking.punch_card_id) {
        await sql`
          UPDATE punch_cards
          SET remaining_uses = remaining_uses + 1,
            status = 'active', version = version + 1
          WHERE org_id = ${this.context.orgId}::uuid
            AND id = ${booking.punch_card_id}::uuid
            AND status IN ('active', 'exhausted')
        `.execute(trx);
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.booking_canceled',
        entityType: 'class_session_booking',
        entityId: bookingId,
        changes: {},
      });
    });
  }

  async listMakeupCredits(input: {
    personId?: string;
    accountId?: string;
    status?: string;
  }): Promise<MakeupCredit[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<{
        id: string;
        person_id: string;
        person_name: string;
        class_offering_id: string;
        offering_name: string;
        source_event_id: string;
        source_starts_at: Date | null;
        expires_on: string;
        used_event_id: string | null;
        status: string;
      }>`
        SELECT credit.id, credit.person_id,
          person.first_name || ' ' || person.last_name AS person_name,
          credit.class_offering_id, offering.name AS offering_name,
          credit.source_event_id, source.starts_at AS source_starts_at,
          credit.expires_on::text, credit.used_event_id, credit.status
        FROM makeup_credits credit
        JOIN people person ON person.org_id = credit.org_id
          AND person.id = credit.person_id
        JOIN class_offerings offering ON offering.org_id = credit.org_id
          AND offering.id = credit.class_offering_id
        JOIN events source ON source.org_id = credit.org_id
          AND source.id = credit.source_event_id
        WHERE credit.org_id = ${this.context.orgId}::uuid
          ${input.personId ? sql`AND credit.person_id = ${input.personId}::uuid` : sql``}
          ${input.status ? sql`AND credit.status = ${input.status}` : sql``}
          ${
            input.accountId
              ? sql`AND EXISTS (
                SELECT 1 FROM person_account_links link
                WHERE link.org_id = credit.org_id
                  AND link.person_id = credit.person_id
                  AND link.account_id = ${input.accountId}::uuid
                  AND link.verified_at IS NOT NULL
                  AND link.revoked_at IS NULL
              )`
              : sql``
          }
        ORDER BY credit.expires_on, credit.created_at
        LIMIT 200
      `.execute(trx);
      return rows.rows.map((row) => ({
        id: row.id,
        personId: row.person_id,
        personName: row.person_name,
        classOfferingId: row.class_offering_id,
        offeringName: row.offering_name,
        sourceEventId: row.source_event_id,
        sourceStartsAt: row.source_starts_at?.toISOString() ?? null,
        expiresOn: dateOnly(row.expires_on),
        usedEventId: row.used_event_id,
        status: row.status as MakeupCredit['status'],
      }));
    });
  }

  async listPunchCards(input: {
    personId?: string;
    accountId?: string;
  }): Promise<PunchCard[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<{
        id: string;
        person_id: string;
        person_name: string;
        class_offering_id: string;
        offering_name: string;
        total_uses: number;
        remaining_uses: number;
        expires_on: string | null;
        status: string;
      }>`
        SELECT card.id, card.person_id,
          person.first_name || ' ' || person.last_name AS person_name,
          card.class_offering_id, offering.name AS offering_name,
          card.total_uses, card.remaining_uses, card.expires_on::text,
          card.status
        FROM punch_cards card
        JOIN people person ON person.org_id = card.org_id
          AND person.id = card.person_id
        JOIN class_offerings offering ON offering.org_id = card.org_id
          AND offering.id = card.class_offering_id
        WHERE card.org_id = ${this.context.orgId}::uuid
          ${input.personId ? sql`AND card.person_id = ${input.personId}::uuid` : sql``}
          ${input.accountId ? sql`AND card.account_id = ${input.accountId}::uuid` : sql``}
        ORDER BY card.created_at DESC
        LIMIT 200
      `.execute(trx);
      return rows.rows.map((row) => ({
        id: row.id,
        personId: row.person_id,
        personName: row.person_name,
        classOfferingId: row.class_offering_id,
        offeringName: row.offering_name,
        totalUses: row.total_uses,
        remainingUses: row.remaining_uses,
        expiresOn: row.expires_on ? dateOnly(row.expires_on) : null,
        status: row.status as PunchCard['status'],
      }));
    });
  }
}
