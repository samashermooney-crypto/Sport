import { newId } from '@shared/ids';
import { apiErrorSchema } from '@shared/schemas/errors';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { createWithOrg } from '../db/withOrg';
import type { AuthDependencies } from '../modules/auth/routes';
import { requireSession } from '../modules/auth/routes';
import { auditImpersonatedRequest } from '../modules/platform/impersonation';
import {
  PlatformAccessError,
  requirePlatformStaff,
} from '../modules/platform/service';

type ImpersonationContext = { id: string; orgId: string; accountId: string };
type ContextRequest = Express.Request & {
  impersonation?: ImpersonationContext;
};

export function requestImpersonation(
  request: Express.Request,
): ImpersonationContext | undefined {
  return (request as ContextRequest).impersonation;
}

const orgPath =
  /(?:^|\/)orgs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function tenantGuard(dependencies: AuthDependencies): RequestHandler {
  const withOrg = createWithOrg(dependencies.database);
  return async (request, response, next) => {
    if (request.path.startsWith('/platform')) {
      next();
      return;
    }
    const header = request.get('X-Athlentry-Impersonation');
    const orgId = orgPath.exec(request.path)?.[1];
    if (!orgId && !header) {
      next();
      return;
    }
    try {
      if (!orgId)
        throw new PlatformAccessError(
          'Impersonation requires an organization route',
          404,
        );
      if (header) {
        const id = z.uuid().parse(header);
        const session = await requireSession(dependencies, request);
        const staff = await requirePlatformStaff(
          dependencies.database,
          session,
          ['super_admin', 'support'],
        );
        await auditImpersonatedRequest(
          dependencies.database,
          staff,
          id,
          {
            method: request.method,
            path: request.path,
            organizationId: orgId,
          },
          dependencies.clock(),
        );
        (request as ContextRequest).impersonation = {
          id,
          orgId,
          accountId: staff.accountId,
        };
        await withOrg(
          { orgId, actor: { accountId: staff.accountId } },
          async (trx) => {
            await trx
              .insertInto('audit_log')
              .values({
                id: newId(),
                org_id: orgId,
                actor_account_id: staff.accountId,
                impersonation_id: id,
                action: 'platform.impersonation_read',
                entity_type: 'organization',
                entity_id: orgId,
                changes: { method: request.method, path: request.path },
              })
              .execute();
          },
        );
      }
      const actorId =
        requestImpersonation(request)?.accountId ??
        (await requireSession(dependencies, request)).accountId;
      const suspended = await withOrg(
        { orgId, actor: { accountId: actorId } },
        async (trx) => {
          const org = await trx
            .selectFrom('organizations')
            .select('status')
            .where('id', '=', orgId)
            .executeTakeFirst();
          if (org?.status !== 'suspended') return false;
          if (requestImpersonation(request)) return true;
          const membership = await trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', orgId)
            .where('account_id', '=', actorId)
            .where('status', '=', 'active')
            .executeTakeFirst();
          return Boolean(membership);
        },
      );
      if (suspended) throw new PlatformAccessError('Organization is suspended');
      next();
    } catch (error) {
      const status =
        error instanceof z.ZodError
          ? 400
          : error instanceof PlatformAccessError
            ? error.status
            : error instanceof Error &&
                'status' in error &&
                error.status === 401
              ? 401
              : 500;
      response.status(status).json(
        apiErrorSchema.parse({
          error: {
            code:
              status === 400
                ? 'VALIDATION_ERROR'
                : status === 401
                  ? 'UNAUTHENTICATED'
                  : status === 404
                    ? 'NOT_FOUND'
                    : status === 403
                      ? 'FORBIDDEN'
                      : 'INTERNAL_ERROR',
            message:
              status === 500
                ? 'Request could not be completed'
                : error instanceof Error
                  ? error.message
                  : 'Request failed',
          },
        }),
      );
    }
  };
}
