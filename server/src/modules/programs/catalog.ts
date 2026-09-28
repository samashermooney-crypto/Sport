import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { ProgramError } from './service';

const publicStatuses = [
  'published',
  'registration_open',
  'registration_closed',
  'in_progress',
  'completed',
];
const anonymousActorId = '00000000-0000-0000-0000-000000000000';

export async function programCatalog(
  database: Kysely<DB>,
  orgSlug: string,
  programSlug?: string,
) {
  const org = await database
    .selectFrom('organizations')
    .select(['id', 'slug', 'name', 'status'])
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!org || org.status !== 'active')
    throw new ProgramError(404, 'NOT_FOUND', 'Program catalog not found');
  return createWithOrg(database)(
    { orgId: org.id, actor: { accountId: anonymousActorId } },
    async (trx) => {
      let query = trx
        .selectFrom('programs')
        .select([
          'id',
          'slug',
          'name',
          'mode',
          'starts_on',
          'ends_on',
          'description_html',
          'status',
          'sport_profile_id',
        ])
        .where('org_id', '=', org.id)
        .where('visibility', '=', 'public')
        .where('status', 'in', publicStatuses);
      if (programSlug) query = query.where('slug', '=', programSlug);
      const programs = await query.orderBy('starts_on', 'asc').execute();
      if (programSlug && programs.length === 0)
        throw new ProgramError(404, 'NOT_FOUND', 'Program not found');
      const result = [];
      for (const program of programs) {
        const profile = await trx
          .selectFrom('sport_profiles')
          .select(['name', 'profile'])
          .where('org_id', '=', org.id)
          .where('id', '=', program.sport_profile_id)
          .executeTakeFirst();
        const divisions = await trx
          .selectFrom('divisions')
          .select([
            'id',
            'name',
            'age_label',
            'competition_gender',
            'level',
            'is_default',
          ])
          .where('org_id', '=', org.id)
          .where('program_id', '=', program.id)
          .orderBy('sort_order')
          .execute();
        const offerings = await trx
          .selectFrom('registration_offerings')
          .select([
            'id',
            'name',
            'division_id',
            'registrant_role',
            'price_cents',
            'capacity',
            'waitlist_enabled',
            'requires_approval',
          ])
          .where('org_id', '=', org.id)
          .where('program_id', '=', program.id)
          .where('active', '=', true)
          .where('visibility', '=', 'public')
          .orderBy('sort_order')
          .execute();
        result.push({
          ...program,
          sport: profile
            ? { name: profile.name, profile: profile.profile }
            : null,
          divisions:
            divisions.length === 1 && divisions[0]?.is_default ? [] : divisions,
          offerings,
        });
      }
      return {
        organization: { slug: org.slug, name: org.name },
        programs: result,
      };
    },
  );
}
