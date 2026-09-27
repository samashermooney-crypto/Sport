import { newId } from '@shared/ids';
import { apiErrorSchema } from '@shared/schemas/errors';
import {
  createOrgResponseSchema,
  createOrgSchema,
  orgCredentialSchema,
  orgCredentialsResponseSchema,
  orgSlugAvailabilitySchema,
  orgSlugSchema,
  sportTemplateCatalogSchema,
  updateOrgCredentialSchema,
} from '@shared/schemas/orgs';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { createOrganization, OrgCreationError } from './create';
import { isOrgSlugAvailable } from './slug';

class OrgCredentialsError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

function mutationOriginIsValid(
  request: express.Request,
  appUrl: string,
): boolean {
  const bearerRequest =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearerRequest && request.get('Origin') === undefined))
  );
}

export function createOrgRouter(
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

  router.get('/slug-availability', async (request, response) => {
    try {
      await requireSession(dependencies, request);
      const slug = orgSlugSchema.parse(request.query.slug);
      const available = await isOrgSlugAvailable(dependencies.database, slug);
      response.json(orgSlugAvailabilitySchema.parse({ slug, available }));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/sport-templates', async (request, response) => {
    try {
      await requireSession(dependencies, request);
      const templates = await dependencies.database
        .selectFrom('sport_templates')
        .select(['key', 'name'])
        .orderBy('name')
        .execute();
      response.json(sportTemplateCatalogSchema.parse(templates));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/', async (request, response) => {
    try {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        response.status(403).json(
          apiErrorSchema.parse({
            error: {
              code: 'FORBIDDEN',
              message: 'Request origin could not be verified',
            },
          }),
        );
        return;
      }
      const session = await requireSession(dependencies, request);
      const input = createOrgSchema.parse(request.body as unknown);
      const result = await createOrganization(
        dependencies.database,
        session.accountId,
        input,
        dependencies.clock(),
      );
      response.status(201).json(createOrgResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });

  async function ownerContext(request: express.Request) {
    const session = await requireSession(dependencies, request);
    const orgId = z.uuid().parse(request.params.orgId);
    const context = { orgId, actor: { accountId: session.accountId } };
    const owner = await withOrg(context, async (trx) => {
      const member = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', session.accountId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!member) return false;
      const role = await trx
        .selectFrom('role_assignments')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', session.accountId)
        .where('role', '=', 'owner')
        .where('scope_type', '=', 'org')
        .where('pending_mfa', '=', false)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Boolean(role);
    });
    if (!owner)
      throw new OrgCredentialsError(404, 'NOT_FOUND', 'Organization not found');
    return { context, session };
  }

  const monthsSchema = z.strictObject({
    months: z.number().int().min(1).max(120),
  });
  function credentialResponse(row: {
    id: string;
    key: string;
    name: string;
    verification: string;
    validity: unknown;
    blocks_activation: boolean;
    active: boolean;
    version: number;
  }) {
    return orgCredentialSchema.parse({
      id: row.id,
      key: row.key,
      name: row.name,
      verification: row.verification,
      validityMonths: monthsSchema.parse(row.validity).months,
      blocksActivation: row.blocks_activation,
      active: row.active,
      version: row.version,
    });
  }

  router.get('/:orgId/credential-types', async (request, response) => {
    try {
      const { context } = await ownerContext(request);
      const rows = await withOrg(context, (trx) =>
        trx
          .selectFrom('credential_types')
          .select([
            'id',
            'key',
            'name',
            'verification',
            'validity',
            'blocks_activation',
            'active',
            'version',
          ])
          .where('org_id', '=', context.orgId)
          .orderBy('name')
          .execute(),
      );
      response.json(
        orgCredentialsResponseSchema.parse(rows.map(credentialResponse)),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.patch(
    '/:orgId/credential-types/:credentialId',
    async (request, response) => {
      try {
        if (!mutationOriginIsValid(request, dependencies.appUrl)) {
          throw new OrgCredentialsError(
            403,
            'FORBIDDEN',
            'Request origin could not be verified',
          );
        }
        const { context, session } = await ownerContext(request);
        if (
          !session.elevatedUntil ||
          session.elevatedUntil <= dependencies.clock()
        ) {
          throw new OrgCredentialsError(
            403,
            'FORBIDDEN',
            'Confirm your identity before changing safety requirements',
          );
        }
        const id = z.uuid().parse(request.params.credentialId);
        const input = updateOrgCredentialSchema.parse(request.body);
        const result = await withOrg(context, async (trx) => {
          const existing = await trx
            .selectFrom('credential_types')
            .select(['id', 'version'])
            .where('id', '=', id)
            .where('org_id', '=', context.orgId)
            .executeTakeFirst();
          if (!existing)
            throw new OrgCredentialsError(
              404,
              'NOT_FOUND',
              'Credential type not found',
            );
          if (existing.version !== input.version)
            throw new OrgCredentialsError(
              409,
              'CONFLICT',
              'Credential type changed; reload before saving',
            );
          const updated = await trx
            .updateTable('credential_types')
            .set({
              name: input.name,
              validity: { months: input.validityMonths },
              blocks_activation: input.blocksActivation,
              active: input.active,
              version: input.version + 1,
            })
            .where('id', '=', id)
            .where('org_id', '=', context.orgId)
            .where('version', '=', input.version)
            .returning([
              'id',
              'key',
              'name',
              'verification',
              'validity',
              'blocks_activation',
              'active',
              'version',
            ])
            .executeTakeFirst();
          if (!updated)
            throw new OrgCredentialsError(
              409,
              'CONFLICT',
              'Credential type changed; reload before saving',
            );
          await trx
            .insertInto('audit_log')
            .values({
              id: newId(),
              org_id: context.orgId,
              actor_account_id: context.actor.accountId,
              action: 'credential_type.updated',
              entity_type: 'credential_type',
              entity_id: id,
              changes: {
                active: input.active,
                blocksActivation: input.blocksActivation,
                validityMonths: input.validityMonths,
              },
            })
            .execute();
          return credentialResponse(updated);
        });
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}

function sendError(response: express.Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    response.status(400).json(
      apiErrorSchema.parse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the organization details',
        },
      }),
    );
  } else if (error instanceof OrgCreationError) {
    const status =
      error.code === 'CONFLICT' ? 409 : error.code === 'FORBIDDEN' ? 403 : 400;
    response.status(status).json(
      apiErrorSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  } else if (error instanceof OrgCredentialsError) {
    response.status(error.status).json(
      apiErrorSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  } else if (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    'code' in error &&
    error.code === 'UNAUTHENTICATED'
  ) {
    response.status(401).json(
      apiErrorSchema.parse({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
      }),
    );
  } else {
    response.status(500).json(
      apiErrorSchema.parse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed',
        },
      }),
    );
  }
}
