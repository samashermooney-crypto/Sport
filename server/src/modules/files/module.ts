import { ageOnDate, orgToday } from '@shared/dates';
import express from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
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

  const canManageFamilyPerson = async (
    context: { orgId: string; actor: { accountId: string } },
    personId: string,
    requirePhotoConsent = false,
  ): Promise<boolean> =>
    scoped(context, async (trx) => {
      const link = await trx
        .selectFrom('person_account_links')
        .innerJoin('people', (join) =>
          join
            .onRef('people.org_id', '=', 'person_account_links.org_id')
            .onRef('people.id', '=', 'person_account_links.person_id'),
        )
        .innerJoin('organizations', 'organizations.id', 'people.org_id')
        .select([
          'person_account_links.relationship',
          'people.date_of_birth',
          'people.status',
          'people.media_consent',
          'organizations.timezone',
        ])
        .where('person_account_links.org_id', '=', context.orgId)
        .where('person_account_links.person_id', '=', personId)
        .where('person_account_links.account_id', '=', context.actor.accountId)
        .where('person_account_links.relationship', 'in', ['guardian', 'self'])
        .where('person_account_links.verified_at', 'is not', null)
        .where('person_account_links.revoked_at', 'is', null)
        .where('people.status', '=', 'active')
        .executeTakeFirst();
      if (!link) return false;
      if (requirePhotoConsent && link.media_consent !== 'granted') return false;
      return (
        link.relationship === 'guardian' ||
        ageOnDate(
          link.date_of_birth.toISOString().slice(0, 10),
          orgToday(link.timezone),
        ) >= 18
      );
    });

  const hasActiveConversationMembership = async (
    context: { orgId: string; actor: { accountId: string } },
    conversationId?: string,
  ): Promise<boolean> =>
    scoped(context, async (trx) => {
      let query = trx
        .selectFrom('conversation_members as member')
        .innerJoin('conversations as conversation', (join) =>
          join
            .onRef('conversation.org_id', '=', 'member.org_id')
            .onRef('conversation.id', '=', 'member.conversation_id'),
        )
        .select('member.id')
        .where('member.org_id', '=', context.orgId)
        .where('member.account_id', '=', context.actor.accountId)
        .where('member.revoked_at', 'is', null)
        .where('conversation.archived_at', 'is', null);
      if (conversationId)
        query = query.where('member.conversation_id', '=', conversationId);
      return Boolean(await query.executeTakeFirst());
    });

  const isChatAttachment = async (
    context: { orgId: string; actor: { accountId: string } },
    fileId: string,
    requireConversationMembership: boolean,
  ): Promise<boolean> =>
    scoped(context, async (trx) => {
      let query = trx
        .selectFrom('chat_messages as message')
        .select('message.id')
        .where('message.org_id', '=', context.orgId)
        .where('message.deleted_at', 'is', null)
        .where(
          sql<boolean>`message.attachments @> ${JSON.stringify([{ fileId }])}::jsonb`,
        );
      if (requireConversationMembership) {
        query = query
          .innerJoin('conversation_members as member', (join) =>
            join
              .onRef('member.org_id', '=', 'message.org_id')
              .onRef('member.conversation_id', '=', 'message.conversation_id'),
          )
          .innerJoin('conversations as conversation', (join) =>
            join
              .onRef('conversation.org_id', '=', 'message.org_id')
              .onRef('conversation.id', '=', 'message.conversation_id'),
          )
          .where('member.account_id', '=', context.actor.accountId)
          .where('member.revoked_at', 'is', null)
          .where('conversation.archived_at', 'is', null);
      }
      return Boolean(await query.executeTakeFirst());
    });

  // The chat portal uploads before it creates the message. For those unscoped
  // uploads, bind download permission to the live message reference instead.
  const isApprovedChatFile = (file: FileRecord): boolean =>
    ['public', 'internal'].includes(file.sensitivity) &&
    ['image', 'document'].includes(file.purpose) &&
    (/^image\/(jpeg|png|webp|heic)$/.test(file.mime) ||
      file.mime === 'application/pdf');

  const restrictedOwnerPersonId = async (
    context: { orgId: string; actor: { accountId: string } },
    ownerType: string,
    ownerId: string,
  ): Promise<string | null> =>
    scoped(context, async (trx) => {
      if (
        ownerType === 'person' ||
        ownerType === 'person_document' ||
        ownerType === 'person_credential'
      ) {
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
      purpose: FilePurpose,
      ownerType?: string,
      ownerId?: string,
      sensitivity: FileSensitivity = 'internal',
    ) => {
      const roles = await membershipRoles(context);
      if (ownerType === 'conversation')
        return (
          ['image', 'document'].includes(purpose) &&
          ['public', 'internal'].includes(sensitivity) &&
          Boolean(ownerId) &&
          (await hasActiveConversationMembership(context, ownerId))
        );
      if (sensitivity !== 'restricted')
        return (
          roles.some((role) => uploadRoles.includes(role)) ||
          (ownerType === 'person' &&
            purpose === 'image' &&
            sensitivity === 'sensitive' &&
            Boolean(ownerId) &&
            (await canManageFamilyPerson(context, ownerId ?? '', true))) ||
          (!ownerType &&
            ['image', 'document'].includes(purpose) &&
            ['public', 'internal'].includes(sensitivity) &&
            (await hasActiveConversationMembership(context)))
        );
      if (!ownerType || !ownerId) return false;
      const personId = await restrictedOwnerPersonId(
        context,
        ownerType,
        ownerId,
      );
      if (!personId) return false;
      if (roles.some((role) => uploadRoles.includes(role))) return true;
      const approvedGuardianEvidence =
        purpose === 'document' &&
        ['person_credential', 'return_to_play_clearance'].includes(ownerType);
      const familyDocument =
        purpose === 'document' && ownerType === 'person_document';
      return (
        (approvedGuardianEvidence || familyDocument) &&
        canManageFamilyPerson(context, personId)
      );
    },
    canDownload: async (context, file: FileRecord) => {
      const roles = await membershipRoles(context);
      if (file.sensitivity === 'restricted') {
        // DEC-125 is the narrow family-portal exception to DEC-023's
        // owner/compliance-only access for other Restricted evidence.
        if (
          file.purpose === 'document' &&
          file.ownerType === 'person_document' &&
          file.ownerId &&
          (await canManageFamilyPerson(context, file.ownerId))
        )
          return true;
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
      if (file.ownerType === 'conversation')
        return (
          isApprovedChatFile(file) &&
          Boolean(file.ownerId) &&
          (await hasActiveConversationMembership(
            context,
            file.ownerId ?? undefined,
          ))
        );
      const referencedByChat =
        isApprovedChatFile(file) &&
        (await isChatAttachment(context, file.id, false));
      if (referencedByChat) return isChatAttachment(context, file.id, true);
      if (file.sensitivity === 'sensitive')
        return (
          (file.ownerType === 'person' &&
            file.purpose === 'image' &&
            Boolean(file.ownerId) &&
            (await canManageFamilyPerson(context, file.ownerId ?? '', true))) ||
          roles.some((role) => ['owner', 'admin', 'registrar'].includes(role))
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
        if (!member) {
          const personLink = await scoped(context, (trx) =>
            trx
              .selectFrom('person_account_links')
              .select('id')
              .where('org_id', '=', context.orgId)
              .where('account_id', '=', accountId)
              .where('revoked_at', 'is', null)
              .executeTakeFirst(),
          );
          if (!personLink) throw new FilePermissionError();
        }
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
