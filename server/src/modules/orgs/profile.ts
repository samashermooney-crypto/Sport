import { newId } from '@shared/ids';
import { orgProfileSchema, updateOrgProfileSchema } from '@shared/schemas/orgs';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

import { OrgMemberRolesError } from './memberRoles';

const defaultBrand = { primaryColor: '#3A67B2', accentColor: '#2F5590' };

async function requireOwner(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
): Promise<void> {
  const row = await trx
    .selectFrom('org_memberships')
    .innerJoin('role_assignments', (join) =>
      join
        .onRef('role_assignments.org_id', '=', 'org_memberships.org_id')
        .onRef(
          'role_assignments.account_id',
          '=',
          'org_memberships.account_id',
        ),
    )
    .select('org_memberships.id')
    .where('org_memberships.org_id', '=', orgId)
    .where('org_memberships.account_id', '=', actorId)
    .where('org_memberships.status', '=', 'active')
    .where('role_assignments.role', '=', 'owner')
    .where('role_assignments.scope_type', '=', 'org')
    .where('role_assignments.pending_mfa', '=', false)
    .where('role_assignments.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row)
    throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Organization not found');
}

function profile(row: {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  kind: string;
  timezone: string;
  address: Json | null;
  phone: string | null;
  email: string | null;
  website_url: string | null;
  default_locale: string;
  brand: Json;
  logo_file_id: string | null;
  nonprofit: boolean;
  version: number;
}): z.output<typeof orgProfileSchema> {
  return orgProfileSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    legalName: row.legal_name,
    kind: row.kind,
    timezone: row.timezone,
    address: row.address,
    phone: row.phone,
    email: row.email,
    websiteUrl: row.website_url,
    defaultLocale: row.default_locale,
    brand: {
      ...defaultBrand,
      ...(typeof row.brand === 'object' &&
      !Array.isArray(row.brand) &&
      row.brand
        ? row.brand
        : {}),
    },
    logoFileId: row.logo_file_id,
    nonprofit: row.nonprofit,
    version: row.version,
  });
}

const selection = [
  'id',
  'name',
  'slug',
  'legal_name',
  'kind',
  'timezone',
  'address',
  'phone',
  'email',
  'website_url',
  'default_locale',
  'brand',
  'logo_file_id',
  'nonprofit',
  'version',
] as const;

export async function getOrgProfile(
  database: Kysely<DB>,
  orgId: string,
  actorId: string,
) {
  return createWithOrg(database)(
    { orgId, actor: { accountId: actorId } },
    async (trx) => {
      await requireOwner(trx, orgId, actorId);
      const row = await trx
        .selectFrom('organizations')
        .select(selection)
        .where('id', '=', orgId)
        .executeTakeFirst();
      if (!row)
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      return profile(row);
    },
  );
}

export async function updateOrgProfile(
  database: Kysely<DB>,
  input: {
    orgId: string;
    actorId: string;
    changes: z.input<typeof updateOrgProfileSchema>;
    now: Date;
  },
): Promise<z.output<typeof orgProfileSchema>> {
  const changes = updateOrgProfileSchema.parse(input.changes);
  return createWithOrg(database)(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      await requireOwner(trx, input.orgId, input.actorId);
      const existing = await trx
        .selectFrom('organizations')
        .select(selection)
        .where('id', '=', input.orgId)
        .forUpdate()
        .executeTakeFirst();
      if (!existing)
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      if (existing.version !== changes.expectedVersion)
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Profile changed; reload before saving',
        );
      if (changes.logoFileId) {
        const file = await trx
          .selectFrom('files')
          .select('id')
          .where('id', '=', changes.logoFileId)
          .where('org_id', '=', input.orgId)
          .where('purpose', '=', 'image')
          .where('owner_type', '=', 'organization')
          .where('owner_id', '=', input.orgId)
          .where('upload_state', '=', 'complete')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!file)
          throw new OrgMemberRolesError(
            404,
            'NOT_FOUND',
            'Logo file not found',
          );
      }
      const updated = await trx
        .updateTable('organizations')
        .set({
          name: changes.name,
          legal_name: changes.legalName,
          timezone: changes.timezone,
          address: changes.address as Json | null,
          phone: changes.phone,
          email: changes.email,
          website_url: changes.websiteUrl,
          default_locale: changes.defaultLocale,
          brand: changes.brand as Json,
          logo_file_id: changes.logoFileId,
          nonprofit: changes.nonprofit,
          version: existing.version + 1,
        })
        .where('id', '=', input.orgId)
        .where('version', '=', existing.version)
        .returning(selection)
        .executeTakeFirst();
      if (!updated)
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Profile changed; reload before saving',
        );
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: input.actorId,
          action: 'organization.profile_updated',
          entity_type: 'organization',
          entity_id: input.orgId,
          changes: {
            beforeVersion: existing.version,
            afterVersion: updated.version,
            name: changes.name,
            logoFileId: changes.logoFileId,
          },
        })
        .execute();
      return profile(updated);
    },
  );
}
