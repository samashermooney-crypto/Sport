import { checkEligibility } from '@shared/sport/eligibility';
import { ageGroupSchema } from '@shared/sport/schema';
import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { createStripeGateway } from '../../integrations/stripe/sdk.js';
import { requestImpersonation } from '../../lib/tenant-guard.js';
import { requireSession, type AuthDependencies } from '../auth/routes.js';

import {
  checkoutQuoteSchema,
  PostgresRegistrationCheckoutQuote,
} from './checkout-quote.js';
import {
  PostgresRegistrationCheckoutStart,
  registrationEligibilityRules,
  registrationCartSchema,
  RegistrationCheckoutError,
  startedCheckoutSchema,
} from './checkout-start.js';
import {
  addFamilyParticipant,
  familyParticipantInputSchema,
  familyParticipantSchema,
} from './family-participants.js';
import {
  approveBodySchema,
  cancelBodySchema,
  myRegistrationListSchema,
  PostgresRegistrationLifecycle,
  registrationCancelResponseSchema,
  registrationRefundPreviewSchema,
  registrationTransferResponseSchema,
  staffRegistrationListSchema,
  transferBodySchema,
  waitlistEntrySchema,
  waitlistJoinBodySchema,
} from './lifecycle.js';
import {
  checkoutPolicyReviewSchema,
  PostgresCheckoutPolicyAcceptance,
} from './policy-acceptance.js';
import {
  PostgresRegistrationReports,
  registrationPaceSchema,
  registrationReportCsv,
  registrationReportFilterSchema,
  registrationReportSchema,
  uniformSizeReportSchema,
} from './reports.js';
import {
  checkoutRequirementsSchema,
  PostgresRegistrationRequirements,
  requirementsDiscoverySchema,
} from './requirements.js';
import {
  acceptTeamEntryInviteSchema,
  createTeamEntrySchema,
  inviteTeamPlayersSchema,
  PostgresTeamEntries,
  teamEntryDecisionSchema,
  teamEntryInvitePreviewSchema,
  teamEntryListSchema,
  teamEntryOptionsSchema,
} from './team-entries.js';
import { PostgresRegistrationTransferRefunds } from './transfer-refunds.js';

function testGateway(): PaymentsGateway {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret?.startsWith('sk_test_'))
    throw new RegistrationCheckoutError(
      503,
      'NOT_TRANSFERABLE',
      'Stripe test gateway is unavailable',
    );
  return createStripeGateway(secret);
}

const catalogItemSchema = z.strictObject({
  programId: z.uuid(),
  programSlug: z.string(),
  programName: z.string(),
  sport: z.string(),
  offeringId: z.uuid(),
  offeringName: z.string(),
  divisionId: z.uuid().nullable(),
  priceCents: z.number().int().nonnegative(),
  status: z.enum(['opens_soon', 'open', 'full', 'closed']),
  waitlistEnabled: z.boolean(),
  eligibleParticipants: z.array(
    z.strictObject({
      personId: z.uuid(),
      householdId: z.uuid(),
      eligible: z.boolean(),
      alreadyRegistered: z.boolean(),
      age: z.number().int().nullable(),
      grade: z.number().int().nullable(),
      ageGroupLabel: z.string().nullable(),
      reasons: z.array(
        z.strictObject({
          code: z.enum([
            'AGE_BELOW_MIN',
            'AGE_ABOVE_MAX',
            'GRADE_OUT_OF_RANGE',
            'GENDER_MISMATCH',
            'MEMBERSHIP_REQUIRED',
            'RETURNING_ONLY',
            'INVITE_ONLY',
            'RESIDENCY',
            'HOUSEHOLD_LIMIT',
            'DATE_OF_BIRTH_REQUIRED',
            'GRADUATION_YEAR_REQUIRED',
          ]),
          message: z.string(),
        }),
      ),
    }),
  ),
});

export const registrationCatalogSchema = z.strictObject({
  items: z.array(catalogItemSchema),
});

export const registrationParticipantsSchema = z.strictObject({
  people: z.array(
    z.strictObject({
      personId: z.uuid(),
      householdId: z.uuid(),
      name: z.string().min(1),
      householdName: z.string().min(1),
    }),
  ),
});

export const checkoutViewSchema = startedCheckoutSchema.extend({
  cart: registrationCartSchema,
});

const staffApprovalBodySchema = approveBodySchema.extend({
  decision: z.enum(['approved', 'declined']),
});

const staffWaitlistOfferBodySchema = z.strictObject({
  offeringId: z.uuid(),
  entryId: z.uuid().optional(),
});

const registrationStatusQuerySchema = z.strictObject({
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

const staffWaitlistQuerySchema = z.strictObject({ offeringId: z.uuid() });

const waitlistOfferResponseSchema = z.union([
  z.strictObject({ entryId: z.uuid(), expiresAt: z.iso.datetime() }),
  z.literal('full'),
  z.literal('empty'),
]);

interface CatalogRow {
  program_id: string;
  slug: string;
  program_name: string;
  sport: string;
  offering_id: string;
  offering_name: string;
  division_id: string | null;
  price_cents: number;
  program_status: string;
  opens_at: Date | null;
  closes_at: Date | null;
  counter_present: boolean;
  capacity: number | null;
  confirmed: number;
  held: number;
  waitlist_enabled: boolean;
  sport_profile: unknown;
  program_eligibility: unknown;
  division_eligibility: unknown;
  season_starts_on: string;
  season_ends_on: string;
}

interface CatalogParticipantRow {
  person_id: string;
  household_id: string;
  date_of_birth: string | null;
  graduation_year: number | null;
  competition_gender: 'female' | 'male' | 'open' | null;
  memberships: string[];
  returning: boolean;
  registered_programs: string[];
}

interface CatalogHouseholdRegistrationCount {
  program_id: string;
  household_id: string;
  registration_count: number;
}

function validWriteOrigin(request: express.Request, appUrl: string): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof RegistrationCheckoutError
        ? error.status
        : error instanceof Error &&
            'status' in error &&
            typeof error.status === 'number'
          ? error.status
          : 500;
  response.status(status).json({
    error: {
      code:
        error instanceof z.ZodError
          ? 'VALIDATION_ERROR'
          : error instanceof RegistrationCheckoutError
            ? error.code
            : status !== 500 &&
                error instanceof Error &&
                'code' in error &&
                typeof error.code === 'string'
              ? error.code
              : status === 401
                ? 'UNAUTHENTICATED'
                : 'INTERNAL_ERROR',
      message:
        status === 500
          ? 'The request could not be completed'
          : error instanceof Error
            ? error.message
            : 'Request failed',
    },
  });
}

export function createRegistrationRouter(
  dependencies: AuthDependencies,
  gatewayFactory: () => PaymentsGateway = testGateway,
): express.Router {
  const router = express.Router();
  const withOrg = createWithOrg(dependencies.database);
  router.use(express.json({ limit: '32kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.get('/orgs/:orgId/catalog', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Impersonation is unavailable',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const sport = z.string().max(80).optional().parse(request.query.sport);
      const now = new Date();
      const catalog = await withOrg(
        { orgId, actor: { accountId: session.accountId } },
        async (trx) => {
          const result = await sql<CatalogRow>`
          SELECT p.id AS program_id, p.slug, p.name AS program_name,
            sp.name AS sport, o.id AS offering_id, o.name AS offering_name,
            o.division_id, o.price_cents, p.status AS program_status,
            p.registration_opens_at AS opens_at,
            p.registration_closes_at AS closes_at,
            (counter.id IS NOT NULL) AS counter_present,
            counter.capacity, coalesce(counter.confirmed, 0)::integer AS confirmed,
            coalesce(counter.held, 0)::integer AS held, o.waitlist_enabled,
            sp.profile AS sport_profile, p.eligibility AS program_eligibility,
            d.eligibility AS division_eligibility,
            s.starts_on::text AS season_starts_on, s.ends_on::text AS season_ends_on
          FROM registration_offerings o
          JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
          JOIN sport_profiles sp ON sp.org_id = p.org_id AND sp.id = p.sport_profile_id
          JOIN seasons s ON s.org_id = p.org_id AND s.id = p.season_id
          JOIN divisions d ON d.org_id = o.org_id AND d.id = o.division_id
          LEFT JOIN capacity_counters counter ON counter.org_id = o.org_id
            AND counter.subject_type = 'offering' AND counter.subject_id = o.id
          WHERE o.org_id = ${orgId}::uuid AND o.active
            AND o.registrant_role = 'athlete'
            AND o.visibility = 'public' AND p.visibility = 'public'
            AND p.status IN ('published', 'registration_open', 'registration_closed')
            AND (${sport ?? null}::text IS NULL OR lower(sp.name) = lower(${sport ?? null}::text))
          ORDER BY p.starts_on, p.name, o.sort_order, o.id LIMIT 100
        `.execute(trx);
          const participantResult = await sql<CatalogParticipantRow>`
          SELECT DISTINCT person.id AS person_id, member.household_id,
            person.date_of_birth::text AS date_of_birth,
            person.graduation_year, person.competition_gender,
            ARRAY(SELECT DISTINCT current.program_id::text FROM registrations current
              WHERE current.org_id = person.org_id AND current.person_id = person.id
                AND current.status = 'confirmed') AS memberships,
            EXISTS (SELECT 1 FROM registrations history
              WHERE history.org_id = person.org_id AND history.person_id = person.id
                AND history.status IN ('confirmed', 'transferred_out', 'withdrawn')) AS returning,
            ARRAY(SELECT DISTINCT enrolled.program_id::text FROM registrations enrolled
              WHERE enrolled.org_id = person.org_id AND enrolled.person_id = person.id
                AND enrolled.status NOT IN ('canceled', 'withdrawn', 'transferred_out'))
              AS registered_programs
          FROM person_account_links link
          JOIN people person ON person.org_id = link.org_id AND person.id = link.person_id
          JOIN household_members member ON member.org_id = link.org_id
            AND member.person_id = link.person_id AND member.removed_at IS NULL
          JOIN households h ON h.org_id = member.org_id AND h.id = member.household_id
          WHERE link.org_id = ${orgId}::uuid
            AND link.account_id = ${session.accountId}::uuid
            AND link.relationship IN ('self', 'guardian')
            AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
            AND person.status = 'active' AND h.status = 'active'
        `.execute(trx);
          const rows = result.rows;
          const participants = participantResult.rows;
          if (!rows.length || !participants.length)
            return { rows, participants, householdCounts: [] };
          const programIds = [...new Set(rows.map((row) => row.program_id))];
          const householdIds = [
            ...new Set(participants.map((person) => person.household_id)),
          ];
          const householdCounts = await sql<CatalogHouseholdRegistrationCount>`
          SELECT registration.program_id, registration.household_id,
            count(*)::integer AS registration_count
          FROM registrations registration
          WHERE registration.org_id = ${orgId}::uuid
            AND registration.program_id IN (${sql.join(
              programIds.map((id) => sql`${id}::uuid`),
            )})
            AND registration.household_id IN (${sql.join(
              householdIds.map((id) => sql`${id}::uuid`),
            )})
            AND registration.status NOT IN ('canceled', 'withdrawn', 'transferred_out')
          GROUP BY registration.program_id, registration.household_id
        `.execute(trx);
          return { rows, participants, householdCounts: householdCounts.rows };
        },
      );
      response.json(
        registrationCatalogSchema.parse({
          items: catalog.rows.map((row) => ({
            programId: row.program_id,
            programSlug: row.slug,
            programName: row.program_name,
            sport: row.sport,
            offeringId: row.offering_id,
            offeringName: row.offering_name,
            divisionId: row.division_id,
            priceCents: row.price_cents,
            status:
              row.counter_present &&
              row.program_status === 'registration_open' &&
              (!row.opens_at || row.opens_at <= now) &&
              (!row.closes_at || row.closes_at > now)
                ? row.capacity !== null &&
                  row.confirmed + row.held >= row.capacity
                  ? 'full'
                  : 'open'
                : row.opens_at && row.opens_at > now
                  ? 'opens_soon'
                  : 'closed',
            waitlistEnabled: row.waitlist_enabled,
            eligibleParticipants: catalog.participants.map((participant) => {
              const ageGroup = z
                .looseObject({ ageGroup: ageGroupSchema })
                .parse(row.sport_profile).ageGroup;
              const householdRegistrations =
                catalog.householdCounts.find(
                  (count) =>
                    count.program_id === row.program_id &&
                    count.household_id === participant.household_id,
                )?.registration_count ?? 0;
              const facts = {
                dateOfBirth: participant.date_of_birth,
                graduationYear: participant.graduation_year,
                seasonStartsOn: row.season_starts_on,
                seasonEndsOn: row.season_ends_on,
                competitionGender: participant.competition_gender,
                activeMembershipProgramIds: participant.memberships,
                returningParticipant: participant.returning,
                invited: false,
                residencyVerified: false,
                householdRegistrations,
              };
              const programResult = checkEligibility(
                registrationEligibilityRules(row.program_eligibility, ageGroup),
                facts,
              );
              const divisionResult = checkEligibility(
                registrationEligibilityRules(
                  row.division_eligibility,
                  ageGroup,
                ),
                facts,
              );
              const reasons = [
                ...new Map(
                  [...programResult.reasons, ...divisionResult.reasons].map(
                    (reason) => [reason.code, reason],
                  ),
                ).values(),
              ];
              return {
                personId: participant.person_id,
                householdId: participant.household_id,
                eligible: reasons.length === 0,
                alreadyRegistered: participant.registered_programs.includes(
                  row.program_id,
                ),
                age: programResult.age,
                grade: programResult.grade,
                ageGroupLabel: programResult.ageGroupLabel,
                reasons,
              };
            }),
          })),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/participants', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Impersonation is unavailable',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const rows = await withOrg(
        { orgId, actor: { accountId: session.accountId } },
        async (trx) => {
          const result = await sql<{
            person_id: string;
            household_id: string;
            name: string;
            household_name: string;
          }>`
          SELECT DISTINCT person.id AS person_id, h.id AS household_id,
            person.first_name || ' ' || person.last_name AS name,
            h.name AS household_name
          FROM person_account_links link
          JOIN people person ON person.org_id = link.org_id AND person.id = link.person_id
          JOIN household_members member ON member.org_id = link.org_id
            AND member.person_id = link.person_id AND member.removed_at IS NULL
          JOIN households h ON h.org_id = member.org_id AND h.id = member.household_id
          WHERE link.org_id = ${orgId}::uuid
            AND link.account_id = ${session.accountId}::uuid
            AND link.relationship IN ('self', 'guardian')
            AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
            AND person.status = 'active' AND h.status = 'active'
          ORDER BY name, household_name, person_id, household_id
        `.execute(trx);
          return result.rows;
        },
      );
      response.json(
        registrationParticipantsSchema.parse({
          people: rows.map((row) => ({
            personId: row.person_id,
            householdId: row.household_id,
            name: row.name,
            householdName: row.household_name,
          })),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/participants', async (request, response) => {
    try {
      if (
        !validWriteOrigin(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Adding family members is unavailable',
        );
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await addFamilyParticipant(
        dependencies.database,
        orgId,
        session.accountId,
        familyParticipantInputSchema.parse(request.body),
      );
      response
        .status(result.created ? 201 : 200)
        .json(familyParticipantSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/me/registrations', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Impersonation is unavailable',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await new PostgresRegistrationLifecycle(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).listMine({ orgId });
      response.json(myRegistrationListSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/me/waitlist', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Impersonation is unavailable',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await new PostgresRegistrationLifecycle(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).listMyWaitlist({ orgId });
      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/me/registrations/:registrationId/cancellation-preview',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Impersonation is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const registrationId = z.uuid().parse(request.params.registrationId);
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).previewCancellation({ orgId, registrationId, staff: false });
        response.json(registrationRefundPreviewSchema.nullable().parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/registrations/:registrationId/cancellation-preview',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Impersonation is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const registrationId = z.uuid().parse(request.params.registrationId);
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).previewCancellation({ orgId, registrationId, staff: true });
        response.json(registrationRefundPreviewSchema.nullable().parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/registrations', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Impersonation is unavailable',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const query = registrationStatusQuerySchema.parse({
        status: request.query.status,
      });
      const result = await new PostgresRegistrationLifecycle(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).listForStaff({
        orgId,
        ...(query.status ? { status: query.status } : {}),
      });
      response.json(staffRegistrationListSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  const reportQuerySchema = registrationReportFilterSchema;
  router.get(
    '/orgs/:orgId/reports/registrations',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration report is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const filters = reportQuerySchema.parse({
          ...(request.query.programId
            ? { programId: request.query.programId }
            : {}),
          ...(request.query.divisionId
            ? { divisionId: request.query.divisionId }
            : {}),
          ...(request.query.offeringId
            ? { offeringId: request.query.offeringId }
            : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
        });
        const result = await new PostgresRegistrationReports(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).list({ orgId, filters });
        response.json(registrationReportSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/reports/registrations.csv',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration report is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const filters = reportQuerySchema.parse({
          ...(request.query.programId
            ? { programId: request.query.programId }
            : {}),
          ...(request.query.divisionId
            ? { divisionId: request.query.divisionId }
            : {}),
          ...(request.query.offeringId
            ? { offeringId: request.query.offeringId }
            : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
        });
        const report = await new PostgresRegistrationReports(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).list({ orgId, filters });
        if (report.truncated)
          throw new RegistrationCheckoutError(
            413,
            'REPORT_TOO_LARGE',
            'Add filters to export this registration report',
          );
        response
          .type('text/csv; charset=utf-8')
          .attachment('registrations.csv')
          .send(registrationReportCsv(report));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/reports/uniform-sizes',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Uniform report is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const filters = reportQuerySchema.parse({
          ...(request.query.programId
            ? { programId: request.query.programId }
            : {}),
          ...(request.query.divisionId
            ? { divisionId: request.query.divisionId }
            : {}),
          ...(request.query.offeringId
            ? { offeringId: request.query.offeringId }
            : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
        });
        const result = await new PostgresRegistrationReports(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).uniformSizes({ orgId, filters });
        response.json(uniformSizeReportSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/reports/pace/:programId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration pace is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const programId = z.uuid().parse(request.params.programId);
        const result = await new PostgresRegistrationReports(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).pace({ orgId, programId });
        response.json(registrationPaceSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/waitlist', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Impersonation is unavailable',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const query = staffWaitlistQuerySchema.parse({
        offeringId: request.query.offeringId,
      });
      const result = await new PostgresRegistrationLifecycle(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).listWaitlistForStaff({ orgId, offeringId: query.offeringId });
      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/me/waitlist', async (request, response) => {
    try {
      if (
        !validWriteOrigin(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Waitlist entry is unavailable',
        );
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const body = waitlistJoinBodySchema.parse(request.body);
      const result = await new PostgresRegistrationLifecycle(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).joinWaitlist({ orgId, ...body });
      response.status(201).json(waitlistEntrySchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/me/waitlist/:entryId/accept',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Waitlist offer is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const entryId = z.uuid().parse(request.params.entryId);
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).acceptWaitlist({ orgId, entryId });
        response.json(z.strictObject({ checkoutId: z.uuid() }).parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/me/waitlist/:entryId/decline',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Waitlist entry is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const entryId = z.uuid().parse(request.params.entryId);
        z.strictObject({}).parse(request.body);
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).declineWaitlist({ orgId, entryId, reason: 'declined' });
        response.json(z.strictObject({ ok: z.literal(true) }).parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/me/registrations/:registrationId/cancel',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration cancellation is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const registrationId = z.uuid().parse(request.params.registrationId);
        const body = cancelBodySchema.parse(request.body);
        const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).cancel({
          orgId,
          registrationId,
          reason: body.reason,
          staff: false,
          idempotencyKey,
        });
        response.json(registrationCancelResponseSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/registrations/:registrationId/cancel',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration cancellation is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const registrationId = z.uuid().parse(request.params.registrationId);
        const body = cancelBodySchema.parse(request.body);
        const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).cancel({
          orgId,
          registrationId,
          reason: body.reason,
          staff: true,
          idempotencyKey,
        });
        response.json(registrationCancelResponseSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/registrations/:registrationId/approval',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration decision is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const registrationId = z.uuid().parse(request.params.registrationId);
        const body = staffApprovalBodySchema.parse(request.body);
        const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).decideApproval({
          orgId,
          registrationId,
          decision: body.decision,
          ...(body.note ? { note: body.note } : {}),
          idempotencyKey,
        });
        response.json(
          z
            .strictObject({
              status: z.string(),
              paymentDueAt: z.iso.datetime().nullable(),
            })
            .parse(result),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/registrations/:registrationId/transfer',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration transfer is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const registrationId = z.uuid().parse(request.params.registrationId);
        const body = transferBodySchema.parse(request.body);
        const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
        const context = { orgId, actor: { accountId: session.accountId } };
        const transferRefunds =
          body.financialTreatment === 'refund_difference'
            ? new PostgresRegistrationTransferRefunds(
                dependencies.database,
                context,
                gatewayFactory(),
              )
            : undefined;
        const result = await new PostgresRegistrationLifecycle(
          dependencies.database,
          context,
          () => new Date(),
          transferRefunds,
        ).transfer({
          orgId,
          registrationId,
          toOfferingId: body.toOfferingId,
          financialTreatment: body.financialTreatment,
          ...(body.note ? { note: body.note } : {}),
          idempotencyKey,
        });
        response.json(registrationTransferResponseSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId/waitlist/offers', async (request, response) => {
    try {
      if (
        !validWriteOrigin(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Waitlist offer is unavailable',
        );
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const body = staffWaitlistOfferBodySchema.parse(request.body);
      const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
      const result = await new PostgresRegistrationLifecycle(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).offerWaitlist({
        orgId,
        offeringId: body.offeringId,
        ...(body.entryId ? { entryId: body.entryId } : {}),
        idempotencyKey,
      });
      response.json(waitlistOfferResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/checkouts', async (request, response) => {
    try {
      if (
        !validWriteOrigin(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Checkout creation is unavailable',
        );
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const creationKey = z.uuid().parse(request.get('Idempotency-Key'));
      const cart = registrationCartSchema.parse(request.body);
      const result = await new PostgresRegistrationCheckoutStart(
        dependencies.database,
        { orgId, actor: { accountId: session.accountId } },
      ).start({ orgId, creationKey, cart });
      response.status(201).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/me/team-entries', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Team entries are unavailable while impersonating',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await new PostgresTeamEntries(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      }).listMine(orgId);
      response.json(teamEntryListSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/team-entry-options', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Team entry options are unavailable while impersonating',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await new PostgresTeamEntries(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      }).options(orgId);
      response.json(teamEntryOptionsSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/team-entries', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Team entries are unavailable while impersonating',
        );
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await new PostgresTeamEntries(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      }).listStaff(orgId);
      response.json(teamEntryListSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/team-entries', async (request, response) => {
    try {
      if (
        !validWriteOrigin(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Team entry registration is unavailable',
        );
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await new PostgresTeamEntries(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      }).create({
        orgId,
        accountId: session.accountId,
        idempotencyKey: z.uuid().parse(request.get('Idempotency-Key')),
        details: createTeamEntrySchema.parse(request.body),
      });
      response.status(201).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/team-entries/:entryId/invites',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Team invitations are unavailable while impersonating',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const entryId = z.uuid().parse(request.params.entryId);
        const result = await new PostgresTeamEntries(dependencies.database, {
          orgId,
          actor: { accountId: session.accountId },
        }).listInvites(orgId, entryId);
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/team-entries/:entryId/invites',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Team invitations are unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const entryId = z.uuid().parse(request.params.entryId);
        const created = await new PostgresTeamEntries(dependencies.database, {
          orgId,
          actor: { accountId: session.accountId },
        }).invitePlayers(
          orgId,
          entryId,
          inviteTeamPlayersSchema.parse(request.body),
        );
        response.status(201).json({
          invites: created.invites.map((invite) => ({
            id: invite.id,
            email: invite.email,
            expiresAt: invite.expiresAt,
            inviteUrl: new URL(
              `/portal/orgs/${orgId}/team-entry-invites/${encodeURIComponent(invite.token)}`,
              dependencies.appUrl,
            ).toString(),
          })),
        });
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/team-entries/:entryId/approval',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Team entry decision is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const entryId = z.uuid().parse(request.params.entryId);
        const body = z
          .strictObject({
            decision: z.enum(['approved', 'declined']),
            note: z.string().trim().max(400).optional(),
          })
          .parse(request.body);
        const result = await new PostgresTeamEntries(dependencies.database, {
          orgId,
          actor: { accountId: session.accountId },
        }).decide(orgId, entryId, body.decision, body.note);
        response.json(teamEntryDecisionSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/team-entry-invites/:token',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Team invitation is unavailable while impersonating',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const result = await new PostgresTeamEntries(dependencies.database, {
          orgId,
          actor: { accountId: session.accountId },
        }).previewInvite(orgId, z.string().parse(request.params.token));
        response.json(teamEntryInvitePreviewSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/team-entry-invites/:token/accept',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Team invitation acceptance is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const result = await new PostgresTeamEntries(dependencies.database, {
          orgId,
          actor: { accountId: session.accountId },
        }).acceptInvite({
          orgId,
          token: z.string().parse(request.params.token),
          details: acceptTeamEntryInviteSchema.parse(request.body),
        });
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/checkouts/:checkoutId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Impersonation is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const checkoutId = z.uuid().parse(request.params.checkoutId);
        const row = await withOrg(
          { orgId, actor: { accountId: session.accountId } },
          (trx) =>
            trx
              .selectFrom('checkouts')
              .select(['id', 'status', 'expires_at', 'items'])
              .where('org_id', '=', orgId)
              .where('id', '=', checkoutId)
              .where('account_id', '=', session.accountId)
              .executeTakeFirst(),
        );
        if (
          !row ||
          !['open', 'awaiting_payment', 'completed'].includes(row.status)
        )
          throw new RegistrationCheckoutError(
            404,
            'NOT_FOUND',
            'Checkout is unavailable',
          );
        response.json(
          checkoutViewSchema.parse({
            checkoutId: row.id,
            status: row.status,
            expiresAt: row.expires_at.toISOString(),
            cart: row.items,
          }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/checkouts/:checkoutId/quote',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Checkout quote is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const checkoutId = z.uuid().parse(request.params.checkoutId);
        const quoteKey = z.uuid().parse(request.get('Idempotency-Key'));
        const result = await new PostgresRegistrationCheckoutQuote(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
          dependencies.encryption,
        ).quote({ orgId, checkoutId, quoteKey });
        response.json(checkoutQuoteSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/checkouts/:checkoutId/requirements',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Impersonation is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const checkoutId = z.uuid().parse(request.params.checkoutId);
        const result = await new PostgresRegistrationRequirements(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
          dependencies.encryption,
        ).discover({ orgId, checkoutId });
        response.json(requirementsDiscoverySchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/checkouts/:checkoutId/requirements',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Checkout requirements are unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const checkoutId = z.uuid().parse(request.params.checkoutId);
        const requirements = checkoutRequirementsSchema.parse(request.body);
        const result = await new PostgresRegistrationRequirements(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
          dependencies.encryption,
        ).submit({
          orgId,
          checkoutId,
          requirements,
          userAgent: request.get('User-Agent') ?? null,
          ip: request.ip ?? null,
        });
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/checkouts/:checkoutId/refund-terms',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Impersonation is unavailable',
          );
        const orgId = z.uuid().parse(request.params.orgId);
        const checkoutId = z.uuid().parse(request.params.checkoutId);
        const result = await new PostgresCheckoutPolicyAcceptance(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).review(checkoutId);
        response.json(checkoutPolicyReviewSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/checkouts/:checkoutId/refund-terms/accept',
    async (request, response) => {
      try {
        if (
          !validWriteOrigin(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Refund terms acceptance is unavailable',
          );
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const checkoutId = z.uuid().parse(request.params.checkoutId);
        const body = z
          .strictObject({ termsHash: z.string().regex(/^[0-9a-f]{64}$/) })
          .parse(request.body);
        const result = await new PostgresCheckoutPolicyAcceptance(
          dependencies.database,
          { orgId, actor: { accountId: session.accountId } },
        ).accept(checkoutId, body.termsHash, request.get('User-Agent') ?? null);
        response.json(checkoutPolicyReviewSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}
