import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import { SharpImageProcessor } from '../../integrations/storage/image-processor';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { createFilesRouter } from './routes';
import { FilePermissionError, FilesService } from './service';
import type { FileAuthorization, FileRecord } from './service';

function createMountedFilesRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const elevated = ['owner', 'admin'];
  const canAccess = async (
    context: { orgId: string; actor: { accountId: string } },
    file?: FileRecord,
  ): Promise<boolean> =>
    scoped(context, async (trx) => {
      const membership = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('account_id', '=', context.actor.accountId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!membership) return false;
      const roles = await trx
        .selectFrom('role_assignments')
        .select('role')
        .where('org_id', '=', context.orgId)
        .where('account_id', '=', context.actor.accountId)
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .where('pending_mfa', '=', false)
        .execute();
      const permitted = new Set(roles.map((role) => role.role));
      if (!file)
        return [...permitted].some((role) =>
          [...elevated, 'registrar'].includes(role),
        );
      if (file.sensitivity === 'restricted')
        return [...permitted].some((role) => elevated.includes(role));
      if (file.sensitivity === 'sensitive')
        return [...permitted].some((role) =>
          [...elevated, 'registrar'].includes(role),
        );
      return true;
    });
  const authorization: FileAuthorization = {
    canUpload: (context) => canAccess(context),
    canDownload: (context, file) => canAccess(context, file),
  };
  const service = new FilesService(
    new LocalDiskStorage('data/uploads'),
    authorization,
    new SharpImageProcessor(),
    scoped,
  );
  router.use((request, response, next) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method,
    );
    const bearer =
      /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
      !request.headers.cookie;
    if (
      mutating &&
      (request.get('X-Athlentry-Request') !== '1' ||
        (request.get('Origin') !== new URL(dependencies.appUrl).origin &&
          !(bearer && !request.get('Origin'))))
    ) {
      response
        .status(403)
        .json({
          error: 'FORBIDDEN',
          message: 'Request origin could not be verified',
        });
      return;
    }
    next();
  });
  router.use(
    createFilesRouter({
      files: service,
      context: async (request) => {
        let accountId: string;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          throw new FilePermissionError();
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success) throw new FilePermissionError();
        const context = { orgId: parsed.data, actor: { accountId } };
        const member = await scoped(context, (trx) =>
          trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('account_id', '=', accountId)
            .where('status', '=', 'active')
            .executeTakeFirst(),
        );
        if (!member) throw new FilePermissionError();
        return context;
      },
    }),
  );
  return router;
}

export const moduleDefinition = {
  name: 'files',
  path: '/api/v1/files',
  router: createMountedFilesRouter,
  permissions: [],
  errorCodes: [],
} satisfies ServerModule;

export { createFilesRouter };
