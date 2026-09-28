import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { modulePermissions } from '@shared/generated/permissions';
import { apiErrorSchema } from '@shared/schemas/errors';
import { healthResponseSchema } from '@shared/schemas/health';
import express from 'express';
import { sql } from 'kysely';

import { getDatabase } from './db/kysely';
import { createWithOrg } from './db/withOrg';
import { apiRouteMetadata, serverModules } from './generated/registry';
import { createStripeWebhookRouter } from './integrations/stripe/webhook-routes';
import type { StripeWebhookDependencies } from './integrations/stripe/webhook-routes';
import type { ServerModule } from './lib/module-contract';
import { publicStatus, readinessResponse } from './lib/observability/health';
import { writeStructuredLog } from './lib/observability/logging';
import { captureRedactedException } from './lib/observability/sentry';
import { createSecurityHeaders } from './lib/security/security-headers';
import { requestImpersonation, tenantGuard } from './lib/tenant-guard';
import type { AuthDependencies } from './modules/auth/routes';
import { requireSession } from './modules/auth/routes';

const organizationPath =
  /(?:^|\/)orgs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
const invitationAcceptancePath =
  /(?:^|\/)(?:guardians\/)?(?:athlete-|claim-)?invitations\/accept$/;

export function collectSeasonRolloverExtras(
  modules: readonly ServerModule[],
): NonNullable<ServerModule['seasonRolloverExtras']>[number][] {
  return modules.flatMap((module) => module.seasonRolloverExtras ?? []);
}

function organizationRelationshipGuard(
  dependencies: AuthDependencies,
): express.RequestHandler {
  const withOrg = createWithOrg(dependencies.database);
  return async (request, response, next) => {
    if (
      request.path.startsWith('/platform') ||
      invitationAcceptancePath.test(request.path) ||
      requestImpersonation(request)
    ) {
      next();
      return;
    }
    const orgId = organizationPath.exec(request.path)?.[1];
    if (!orgId) {
      next();
      return;
    }
    try {
      const session = await requireSession(dependencies, request);
      const hasRelationship = await withOrg(
        { orgId, actor: { accountId: session.accountId } },
        async (trx) => {
          const membership = await trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', orgId)
            .where('account_id', '=', session.accountId)
            .where('status', '=', 'active')
            .executeTakeFirst();
          if (membership) return true;

          const personLink = await trx
            .selectFrom('person_account_links as links')
            .innerJoin('people as person', (join) =>
              join
                .onRef('person.id', '=', 'links.person_id')
                .onRef('person.org_id', '=', 'links.org_id'),
            )
            .select('links.id')
            .where('links.org_id', '=', orgId)
            .where('links.account_id', '=', session.accountId)
            .where('links.verified_at', 'is not', null)
            .where('links.revoked_at', 'is', null)
            .where('person.status', '=', 'active')
            .where('person.merged_into_id', 'is', null)
            .executeTakeFirst();
          return Boolean(personLink);
        },
      );
      if (hasRelationship) {
        next();
        return;
      }
      response.status(404).json(
        apiErrorSchema.parse({
          error: { code: 'NOT_FOUND', message: 'Resource not found' },
        }),
      );
    } catch (error) {
      next(error);
    }
  };
}

export type OperationalHealthDependencies = {
  databaseReady: () => Promise<boolean>;
  workerReady: () => Promise<boolean>;
};

async function databaseReady(): Promise<boolean> {
  try {
    await sql.raw('SELECT 1').execute(getDatabase());
    return true;
  } catch {
    return false;
  }
}

async function workerReady(): Promise<boolean> {
  try {
    const result = await sql<{ heartbeat_at: Date | null }>`
      SELECT max(heartbeat_at) AS heartbeat_at
      FROM worker_heartbeats WHERE stopped_at IS NULL
    `.execute(getDatabase());
    const heartbeat = result.rows[0]?.heartbeat_at;
    return Boolean(heartbeat && Date.now() - heartbeat.getTime() <= 90_000);
  } catch {
    return false;
  }
}

export function createApp(
  auth?: AuthDependencies,
  stripeWebhooks?: StripeWebhookDependencies,
  health: OperationalHealthDependencies = { databaseReady, workerReady },
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const logRequestId = `req:${requestId}`;
    response.setHeader('x-request-id', logRequestId);
    response.once('finish', () => {
      const statusCode = response.statusCode;
      writeStructuredLog(
        statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        'http.response',
        {
          requestId: logRequestId,
          statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
      );
    });
    next();
  });
  app.use(
    createSecurityHeaders({
      ...(process.env.ATHLENTRY_STORAGE_PUBLIC_ORIGIN
        ? {
            storagePublicOrigin: process.env.ATHLENTRY_STORAGE_PUBLIC_ORIGIN,
          }
        : {}),
    }),
  );
  const securityContactFile = readFileSync(
    resolve('docs/security/security.txt'),
    'utf8',
  );
  app.get('/.well-known/security.txt', (_request, response) => {
    if (process.env.NODE_ENV === 'production') {
      const contact = process.env.ATHLENTRY_SECURITY_CONTACT;
      const policy = process.env.ATHLENTRY_SECURITY_POLICY_URL;
      if (
        !contact?.startsWith('mailto:') ||
        !policy?.startsWith('https://') ||
        contact.includes('.example') ||
        policy.includes('.example')
      ) {
        response
          .status(503)
          .type('text/plain')
          .send('Security contact is not configured.');
        return;
      }
      response
        .type('text/plain')
        .send(
          securityContactFile
            .replace(/^Contact:.*$/m, `Contact: ${contact}`)
            .replace(/^Policy:.*$/m, `Policy: ${policy}`),
        );
      return;
    }
    response.type('text/plain').send(securityContactFile);
  });
  const knownPermissions = new Set<string>(modulePermissions);
  for (const module of serverModules) {
    for (const permission of module.permissions ?? []) {
      if (!knownPermissions.has(permission)) {
        throw new Error(`Unknown module permission: ${permission}`);
      }
    }
  }
  for (const metadata of apiRouteMetadata as readonly unknown[]) {
    if (!metadata || typeof metadata !== 'object')
      throw new Error('Generated API route metadata is malformed');
    const route = metadata as Record<string, unknown>;
    if (!route.permission || !route.resource || !route.scope) {
      throw new Error(
        `API route is missing generated security metadata: ${String(route.method)} ${String(route.path)}`,
      );
    }
  }
  app.get('/healthz', (_request, response) => {
    response.json(healthResponseSchema.parse({ status: 'ok' }));
  });
  app.get('/readyz', async (_request, response) => {
    const ready = await health.databaseReady().catch(() => false);
    response.status(ready ? 200 : 503).json(readinessResponse(ready));
  });
  app.get('/status', async (_request, response) => {
    const [database, worker] = await Promise.all([
      health.databaseReady().catch(() => false),
      health.workerReady().catch(() => false),
    ]);
    const status = publicStatus({ api: true, database, worker });
    response.status(status.status === 'operational' ? 200 : 503).json(status);
  });
  // Stripe signatures cover the original bytes, so this ingress route must stay
  // ahead of tenant and feature routers that may parse request bodies.
  if (stripeWebhooks) {
    app.use('/api/v1/webhooks', createStripeWebhookRouter(stripeWebhooks));
  }
  if (auth) {
    const seasonRolloverExtras = collectSeasonRolloverExtras(serverModules);
    for (const module of serverModules) {
      if (module.publicRouter) app.use(module.publicRouter(auth));
    }
    app.use('/api/v1', tenantGuard(auth));
    app.use('/api/v1', organizationRelationshipGuard(auth));
    for (const module of serverModules) {
      if (module.router) {
        const dependencies =
          module.name === 'seasons' ? { ...auth, seasonRolloverExtras } : auth;
        app.use(module.path, module.router(dependencies));
      }
      for (const extra of module.extraRouters ?? []) {
        app.use(extra.path, extra.router(auth));
      }
    }
  }
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist/web'));
    app.use((request, response, next) => {
      if (request.method === 'GET' && request.accepts('html')) {
        response.sendFile(resolve('dist/web/index.html'));
      } else {
        next();
      }
    });
  }
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      const requestId = response.getHeader('x-request-id');
      writeStructuredLog('error', 'http.unhandled_error', {
        ...(typeof requestId === 'string' ? { requestId } : {}),
        statusCode: 500,
      });
      captureRedactedException(error);
      response.status(500).json(
        apiErrorSchema.parse({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
          },
        }),
      );
    },
  );
  return app;
}
