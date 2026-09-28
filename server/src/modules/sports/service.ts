import { newId } from '@shared/ids';
import { sportProfileSchema } from '@shared/sport/schema';
import type { SportProfile } from '@shared/sport/schema';
import {
  builtInSportTemplates,
  builtInSportTemplatesByKey,
} from '@shared/sport/templates';
import type { Kysely } from 'kysely';

import type { DB, Json } from '../../db/types';
import { createWithOrg, type OrgContext } from '../../db/withOrg';
import { requireStaff } from '../people/repo';

export class SportsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sportTemplates() {
  return builtInSportTemplates.map((profile) => ({
    key: profile.key,
    name: profile.name,
    category: profile.category,
    profile,
  }));
}

export class SportsService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  list() {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const rows = await trx
        .selectFrom('sport_profiles')
        .select(['id', 'template_key', 'name', 'profile', 'version'])
        .where('org_id', '=', this.context.orgId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const result = [];
      for (const row of rows) {
        const played = await trx
          .selectFrom('contests')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('sport_profile_id', '=', row.id)
          .where('status', 'in', ['final', 'forfeit'])
          .executeTakeFirst();
        result.push({ ...row, hasResults: Boolean(played) });
      }
      return result;
    });
  }

  async clone(templateKey: string) {
    const profile = builtInSportTemplatesByKey.get(templateKey);
    if (!profile)
      throw new SportsError(404, 'NOT_FOUND', 'Sport template not found');
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const id = newId();
      const row = await trx
        .insertInto('sport_profiles')
        .values({
          id,
          org_id: this.context.orgId,
          template_key: templateKey,
          name: profile.name.en,
          profile: profile as Json,
          version: 1,
        })
        .onConflict((oc) => oc.columns(['org_id', 'template_key']).doNothing())
        .returning(['id', 'template_key', 'name', 'profile', 'version'])
        .executeTakeFirst();
      if (!row)
        throw new SportsError(
          409,
          'CONFLICT',
          'This sport template is already in your organization',
        );
      return row;
    });
  }

  update(id: string, expectedVersion: number, input: SportProfile) {
    const profile = sportProfileSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('sport_profiles')
        .select(['id', 'version'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .where('archived_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new SportsError(404, 'NOT_FOUND', 'Sport profile not found');
      if (current.version !== expectedVersion)
        throw new SportsError(
          409,
          'VERSION_CONFLICT',
          'Sport profile changed; reload before saving',
        );
      const row = await trx
        .updateTable('sport_profiles')
        .set({ name: profile.name.en, profile: profile as Json })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returning(['id', 'template_key', 'name', 'profile', 'version'])
        .executeTakeFirstOrThrow();
      return row;
    });
  }

  history(id: string) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      return trx
        .selectFrom('sport_profile_versions')
        .select(['version', 'profile', 'created_at'])
        .where('org_id', '=', this.context.orgId)
        .where('sport_profile_id', '=', id)
        .orderBy('version', 'desc')
        .execute();
    });
  }
}
