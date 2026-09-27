import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg.js';
import { requestImpersonation } from '../../lib/tenant-guard.js';
import { requireSession, type AuthDependencies } from '../auth/routes.js';

import {
  PostgresRegistrationCheckoutStart,
  registrationCartSchema,
  RegistrationCheckoutError,
  startedCheckoutSchema,
} from './checkout-start.js';

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
});

export const registrationCatalogSchema = z.strictObject({
  items: z.array(catalogItemSchema),
});

export const checkoutViewSchema = startedCheckoutSchema.extend({
  cart: registrationCartSchema,
});

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
      const rows = await withOrg(
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
            coalesce(counter.held, 0)::integer AS held, o.waitlist_enabled
          FROM registration_offerings o
          JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
          JOIN sport_profiles sp ON sp.org_id = p.org_id AND sp.id = p.sport_profile_id
          LEFT JOIN capacity_counters counter ON counter.org_id = o.org_id
            AND counter.subject_type = 'offering' AND counter.subject_id = o.id
          WHERE o.org_id = ${orgId}::uuid AND o.active
            AND o.visibility = 'public' AND p.visibility = 'public'
            AND p.status IN ('published', 'registration_open', 'registration_closed')
            AND (${sport ?? null}::text IS NULL OR lower(sp.name) = lower(${sport ?? null}::text))
          ORDER BY p.starts_on, p.name, o.sort_order, o.id LIMIT 100
        `.execute(trx);
          return result.rows;
        },
      );
      response.json(
        registrationCatalogSchema.parse({
          items: rows.map((row) => ({
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
          })),
        }),
      );
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
  return router;
}
