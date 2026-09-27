import express from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { SharpImageProcessor } from '../../integrations/storage/image-processor';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { createFilesRouter } from './routes';
import { FilePermissionError, FilesService } from './service';
import type {
  FileAuthorization,
  FilePurpose,
  FileRecord,
  FileSensitivity,
} from './service';

export function createFilesAuthorization(
  database: Kysely<DB>,
): FileAuthorization {
  const scoped = createWithOrg(database);
  const uploadRoles = ['owner', 'admin', 'registrar'];
  const restrictedReaderRoles = ['owner', 'compliance'];

  const membershipRoles = async (context: {
    orgId: string;
    actor: { accountId: string };
  }): Promise<string[]> =>
    scoped(context, async (trx) => {
      const membership = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('account_id', '=', context.actor.accountId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!membership) return [];
      const roles = await trx
        .selectFrom('role_assignments')
        .select('role')
        .where('org_id', '=', context.orgId)
        .where('account_id', '=', context.actor.accountId)
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .where('pending_mfa', '=', false)
        .execute();
      return roles.map((role) => role.role);
    });

  const isVerifiedGuardianForPerson = async (
    context: { orgId: string; actor: { accountId: string } },
    personId: string,
  ): Promise<boolean> =>
    scoped(context, async (trx) => {
      const link = await trx
        .selectFrom('person_account_links')
        .innerJoin('people', (join) =>
          join
            .onRef('people.org_id', '=', 'person_account_links.org_id')
            .onRef('people.id', '=', 'person_account_links.person_id'),
        )
        .select('person_account_links.id')
        .where('person_account_links.org_id', '=', context.orgId)
        .where('person_account_links.person_id', '=', personId)
        .where('person_account_links.account_id', '=', context.actor.accountId)
        .where('person_account_links.relationship', '=', 'guardian')
        .where('person_account_links.verified_at', 'is not', null)
        .where('person_account_links.revoked_at', 'is', null)
        .executeTakeFirst();
      return Boolean(link);
    });

  const restrictedOwnerPersonId = async (
    context: { orgId: string; actor: { accountId: string } },
    ownerType: string,
    ownerId: string,
  ): Promise<string | null> =>
    scoped(context, async (trx) => {
      if (ownerType === 'person' || ownerType === 'person_credential') {
        const person = await trx
          .selectFrom('people')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('id', '=', ownerId)
          .executeTakeFirst();
        return person?.id ?? null;
      }
      if (ownerType === 'return_to_play_clearance') {
        const report = await trx
          .selectFrom('injury_reports')
          .innerJoin('people', (join) =>
            join
              .onRef('people.org_id', '=', 'injury_reports.org_id')
              .onRef('people.id', '=', 'injury_reports.person_id'),
          )
          .select('injury_reports.person_id')
          .where('injury_reports.org_id', '=', context.orgId)
          .where('injury_reports.id', '=', ownerId)
          .executeTakeFirst();
        return report?.person_id ?? null;
      }
      return null;
    });

  return {
    canUpload: async (
      context,
      _purpose: FilePurpose,
      ownerType?: string,
      ownerId?: string,
      sensitivity: FileSensitivity = 'internal',
    ) => {
      const roles = await membershipRoles(context);
      if (sensitivity !== 'restricted')
        return roles.some((role) => uploadRoles.includes(role));
      if (!ownerType || !ownerId) return false;
      const personId = await restrictedOwnerPersonId(
        context,
        ownerType,
        ownerId,
      );
      if (!personId) return false;
      if (roles.some((role) => uploadRoles.includes(role))) return true;
      return isVerifiedGuardianForPerson(context, personId);
    },
    canDownload: async (context, file: FileRecord) => {
      const roles = await membershipRoles(context);
      if (file.sensitivity === 'restricted') {
        if (
          !roles.some((role) => restrictedReaderRoles.includes(role)) ||
          !file.ownerType ||
          !file.ownerId
        )
          return false;
        return Boolean(
          await restrictedOwnerPersonId(context, file.ownerType, file.ownerId),
        );
      }
      if (file.sensitivity === 'sensitive')
        return roles.some((role) =>
          ['owner', 'admin', 'registrar'].includes(role),
        );
      return roles.length > 0;
    },
  };
}

function createMountedFilesRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const authorization = createFilesAuthorization(dependencies.database);
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
      response.status(403).json({
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
