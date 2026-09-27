import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import {
  checkEligibility,
  type EligibilityRules,
} from '@shared/sport/eligibility';
import { ageGroupSchema } from '@shared/sport/schema';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { PostgresCheckoutHoldRepository } from '../checkout/capacity-repo.js';
import type { SubjectQuantity } from '../checkout/service.js';

export const registrationCartSchema = z.strictObject({
  offerings: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        offeringId: z.uuid(),
        personId: z.uuid(),
        householdId: z.uuid(),
      }),
    )
    .min(1)
    .max(20),
});

export const startedCheckoutSchema = z.strictObject({
  checkoutId: z.uuid(),
  expiresAt: z.iso.datetime(),
  status: z.enum(['open', 'awaiting_payment', 'completed']),
});

const eligibilitySchema = z.strictObject({
  minAge: z.number().int().nonnegative().optional(),
  maxAge: z.number().int().nonnegative().optional(),
  minGrade: z.number().int().optional(),
  maxGrade: z.number().int().optional(),
  competitionGender: z.enum(['female', 'male', 'open']).optional(),
  requiredMembershipProgramIds: z.array(z.uuid()).optional(),
  returningOnly: z.boolean().optional(),
  inviteOnly: z.boolean().optional(),
  residencyRequired: z.boolean().optional(),
  maxRegistrationsPerHousehold: z.number().int().positive().optional(),
});

interface Candidate {
  program_id: string;
  division_id: string | null;
  program_status: string;
  program_visibility: string;
  offering_visibility: string;
  active: boolean;
  registrant_role: string;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  season_starts_on: string;
  season_ends_on: string;
  profile: Json;
  program_eligibility: Json;
  division_eligibility: Json | null;
  date_of_birth: string;
  graduation_year: number | null;
  competition_gender: 'female' | 'male' | 'open' | null;
  access_ok: boolean;
  registered: boolean;
  household_registrations: number;
  returning: boolean;
  memberships: string[];
}

interface ExistingCheckout {
  id: string;
  status: string;
  expires_at: Date;
  creation_hash: string;
}

export class RegistrationCheckoutError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function rules(
  value: Json,
  ageGroup: z.output<typeof ageGroupSchema>,
): EligibilityRules {
  const parsed = eligibilitySchema.parse(value);
  const defined = Object.fromEntries(
    Object.entries(parsed).filter(([, item]) => item !== undefined),
  ) as Omit<EligibilityRules, 'ageGroup'>;
  return { ageGroup, ...defined };
}

function addSubject(
  subjects: Map<string, SubjectQuantity>,
  subject: SubjectQuantity,
): void {
  const key = `${subject.subject}:${subject.id}`;
  const previous = subjects.get(key);
  subjects.set(key, {
    ...subject,
    quantity: (previous?.quantity ?? 0) + subject.quantity,
  });
}

/** Opens or resumes a family cart, then reserves every seat through the shared hold service. */
export class PostgresRegistrationCheckoutStart {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async start(input: {
    orgId: string;
    creationKey: string;
    cart: z.input<typeof registrationCartSchema>;
  }): Promise<z.output<typeof startedCheckoutSchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    const key = z.uuid().parse(input.creationKey);
    const cart = registrationCartSchema.parse(input.cart);
    if (
      new Set(cart.offerings.map((item) => item.lineId)).size !==
      cart.offerings.length
    )
      throw new RegistrationCheckoutError(
        400,
        'DUPLICATE_LINE',
        'Cart line IDs must be distinct',
      );
    const hash = createHash('sha256')
      .update(JSON.stringify(cart))
      .digest('hex');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 20 * 60_000);
    let claim: {
      checkout: ExistingCheckout;
      subjects: SubjectQuantity[] | null;
    };
    try {
      claim = await this.withOrg(this.context, async (trx) => {
        const existing = await sql<ExistingCheckout>`
        SELECT id, status, expires_at, creation_hash FROM checkouts
        WHERE org_id = ${input.orgId}::uuid
          AND account_id = ${this.context.actor.accountId}::uuid
          AND creation_key = ${key}::uuid FOR UPDATE
      `.execute(trx);
        if (existing.rows[0]) {
          if (existing.rows[0].creation_hash !== hash)
            throw new RegistrationCheckoutError(
              409,
              'KEY_CONFLICT',
              'Checkout key already describes another cart',
            );
          return { checkout: existing.rows[0], subjects: null };
        }
        const subjects = new Map<string, SubjectQuantity>();
        const seen = new Set<string>();
        for (const item of cart.offerings) {
          const candidate = await this.candidate(trx, input.orgId, item);
          if (!candidate || !candidate.access_ok)
            throw new RegistrationCheckoutError(
              403,
              'PARTICIPANT_ACCESS',
              'Participant is unavailable',
            );
          const duplicate = `${candidate.program_id}:${item.personId}`;
          if (seen.has(duplicate) || candidate.registered)
            throw new RegistrationCheckoutError(
              409,
              'ALREADY_REGISTERED',
              'Participant already has a registration in this program',
            );
          seen.add(duplicate);
          if (
            candidate.program_status !== 'registration_open' ||
            candidate.program_visibility !== 'public' ||
            candidate.offering_visibility !== 'public' ||
            !candidate.active ||
            candidate.registrant_role !== 'athlete' ||
            !candidate.division_id ||
            (candidate.registration_opens_at &&
              candidate.registration_opens_at > now) ||
            (candidate.registration_closes_at &&
              candidate.registration_closes_at <= now)
          )
            throw new RegistrationCheckoutError(
              409,
              'REGISTRATION_CLOSED',
              'This offering is not open for registration',
            );
          const ageGroup = z
            .looseObject({ ageGroup: ageGroupSchema })
            .parse(candidate.profile).ageGroup;
          const facts = {
            dateOfBirth: candidate.date_of_birth,
            graduationYear: candidate.graduation_year,
            seasonStartsOn: candidate.season_starts_on,
            seasonEndsOn: candidate.season_ends_on,
            competitionGender: candidate.competition_gender,
            activeMembershipProgramIds: candidate.memberships,
            returningParticipant: candidate.returning,
            invited: false,
            residencyVerified: false,
            householdRegistrations: candidate.household_registrations,
          };
          const results = [
            checkEligibility(
              rules(candidate.program_eligibility, ageGroup),
              facts,
            ),
            checkEligibility(
              rules(candidate.division_eligibility ?? {}, ageGroup),
              facts,
            ),
          ];
          const reasons = [
            ...new Set(
              results.flatMap((result) =>
                result.reasons.map((reason) => reason.code),
              ),
            ),
          ];
          if (reasons.length)
            throw new RegistrationCheckoutError(
              409,
              'INELIGIBLE',
              `Participant is ineligible: ${reasons.join(', ')}`,
            );
          addSubject(subjects, {
            subject: 'program',
            id: candidate.program_id,
            quantity: 1,
          });
          addSubject(subjects, {
            subject: 'division',
            id: candidate.division_id,
            quantity: 1,
          });
          addSubject(subjects, {
            subject: 'offering',
            id: item.offeringId,
            quantity: 1,
          });
        }
        const checkoutId = newId();
        await sql`
        INSERT INTO checkouts
          (id, org_id, account_id, status, expires_at, items, creation_key, creation_hash)
        VALUES
          (${checkoutId}::uuid, ${input.orgId}::uuid,
           ${this.context.actor.accountId}::uuid, 'open', ${expiresAt},
           ${JSON.stringify(cart)}::jsonb, ${key}::uuid, ${hash})
      `.execute(trx);
        await appendAuditEvent(trx, this.context, {
          action: 'checkout.started',
          entityType: 'checkout',
          entityId: checkoutId,
          changes: {
            participantCount: {
              tier: 'internal',
              after: cart.offerings.length,
            },
          },
        });
        return {
          checkout: {
            id: checkoutId,
            status: 'open',
            expires_at: expiresAt,
            creation_hash: hash,
          },
          subjects: [...subjects.values()],
        };
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'checkouts_account_creation_key_idx'
      )
        return this.start(input);
      throw error;
    }
    const checkout = claim.checkout;
    if (checkout.expires_at <= this.now())
      throw new RegistrationCheckoutError(
        409,
        'CHECKOUT_EXPIRED',
        'Checkout has expired',
      );
    if (checkout.status === 'open') {
      const reservation = await new PostgresCheckoutHoldRepository(
        this.database,
        this.context,
      ).reserve({
        orgId: input.orgId,
        checkoutId: checkout.id,
        subjects:
          claim.subjects ?? (await this.subjectsForExisting(cart, input.orgId)),
        expiresAt: checkout.expires_at.toISOString(),
        idempotencyKey: key,
      });
      if (reservation === 'full')
        throw new RegistrationCheckoutError(
          409,
          'CAPACITY_FULL',
          'This offering is full',
        );
    }
    if (!['open', 'awaiting_payment', 'completed'].includes(checkout.status))
      throw new RegistrationCheckoutError(
        409,
        'CHECKOUT_UNAVAILABLE',
        'Checkout is unavailable',
      );
    return startedCheckoutSchema.parse({
      checkoutId: checkout.id,
      expiresAt: checkout.expires_at.toISOString(),
      status: checkout.status,
    });
  }

  private async subjectsForExisting(
    cart: z.output<typeof registrationCartSchema>,
    orgId: string,
  ): Promise<SubjectQuantity[]> {
    return this.withOrg(this.context, async (trx) => {
      const subjects = new Map<string, SubjectQuantity>();
      for (const item of cart.offerings) {
        const row = await trx
          .selectFrom('registration_offerings')
          .select(['program_id', 'division_id'])
          .where('org_id', '=', orgId)
          .where('id', '=', item.offeringId)
          .executeTakeFirstOrThrow();
        if (!row.division_id)
          throw new RegistrationCheckoutError(
            409,
            'REGISTRATION_CLOSED',
            'Offering lacks a division',
          );
        addSubject(subjects, {
          subject: 'program',
          id: row.program_id,
          quantity: 1,
        });
        addSubject(subjects, {
          subject: 'division',
          id: row.division_id,
          quantity: 1,
        });
        addSubject(subjects, {
          subject: 'offering',
          id: item.offeringId,
          quantity: 1,
        });
      }
      return [...subjects.values()];
    });
  }

  private async candidate(
    trx: OrgTransaction,
    orgId: string,
    item: z.output<typeof registrationCartSchema>['offerings'][number],
  ): Promise<Candidate | null> {
    const result = await sql<Candidate>`
      SELECT o.program_id, o.division_id, o.registrant_role,
        p.status AS program_status,
        p.visibility AS program_visibility, o.visibility AS offering_visibility,
        o.active, p.registration_opens_at, p.registration_closes_at,
        s.starts_on::text AS season_starts_on, s.ends_on::text AS season_ends_on,
        sp.profile, p.eligibility AS program_eligibility,
        d.eligibility AS division_eligibility,
        person.date_of_birth::text, person.graduation_year,
        person.competition_gender,
        EXISTS (
          SELECT 1 FROM person_account_links link
          JOIN household_members member ON member.org_id = link.org_id
            AND member.person_id = link.person_id
          JOIN households h ON h.org_id = member.org_id AND h.id = member.household_id
          WHERE link.org_id = o.org_id AND link.person_id = ${item.personId}::uuid
            AND link.account_id = ${this.context.actor.accountId}::uuid
            AND link.relationship IN ('self', 'guardian')
            AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
            AND member.household_id = ${item.householdId}::uuid
            AND member.removed_at IS NULL AND h.status = 'active'
        ) AS access_ok,
        EXISTS (SELECT 1 FROM registrations existing
          WHERE existing.org_id = o.org_id AND existing.program_id = o.program_id
            AND existing.person_id = ${item.personId}::uuid
            AND existing.status NOT IN ('canceled', 'withdrawn', 'transferred_out')) AS registered,
        (SELECT count(*)::integer FROM registrations sibling
          WHERE sibling.org_id = o.org_id AND sibling.program_id = o.program_id
            AND sibling.household_id = ${item.householdId}::uuid
            AND sibling.status NOT IN ('canceled', 'withdrawn', 'transferred_out')) AS household_registrations,
        EXISTS (SELECT 1 FROM registrations prior
          WHERE prior.org_id = o.org_id AND prior.person_id = ${item.personId}::uuid
            AND prior.status IN ('confirmed', 'transferred_out', 'withdrawn')) AS returning,
        ARRAY(SELECT DISTINCT membership.program_id::text FROM registrations membership
          WHERE membership.org_id = o.org_id AND membership.person_id = ${item.personId}::uuid
            AND membership.status = 'confirmed') AS memberships
      FROM registration_offerings o
      JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
      JOIN divisions d ON d.org_id = o.org_id AND d.id = o.division_id
      JOIN seasons s ON s.org_id = p.org_id AND s.id = p.season_id
      JOIN sport_profiles sp ON sp.org_id = p.org_id AND sp.id = p.sport_profile_id
      JOIN people person ON person.org_id = o.org_id AND person.id = ${item.personId}::uuid
        AND person.status = 'active'
      WHERE o.org_id = ${orgId}::uuid AND o.id = ${item.offeringId}::uuid
      FOR UPDATE OF o, p, d, person
    `.execute(trx);
    return result.rows[0] ?? null;
  }
}
