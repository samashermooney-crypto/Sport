import { newId } from '@shared/ids';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

export class OnboardingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const ONBOARDING_ITEMS = [
  {
    key: 'connect_payments',
    label: 'Connect payments',
    href: '/console/settings/payments',
    description: 'Link a Stripe account so families can pay online.',
  },
  {
    key: 'users_roles',
    label: 'Set up users and roles',
    href: '/console/settings/members',
    description: 'Invite staff and assign roles like registrar or treasurer.',
  },
  {
    key: 'choose_sports',
    label: 'Choose sports',
    href: '/console/settings/sports',
    description: 'Pick the sports your organization runs.',
  },
  {
    key: 'create_program',
    label: 'Create a season or program',
    href: '/console/programs/new',
    description: 'Use the wizard to stand up your first program.',
  },
  {
    key: 'add_facilities',
    label: 'Add facilities',
    href: '/console/facilities',
    description: 'Add the fields, courts, or rinks you play on.',
  },
  {
    key: 'configure_compliance',
    label: 'Configure compliance requirements',
    href: '/console/compliance',
    description: 'Require background checks or certifications for staff.',
  },
  {
    key: 'import_members',
    label: 'Import members',
    href: '/console/imports',
    description: 'Bring in people, rosters, and history from spreadsheets.',
  },
  {
    key: 'publish_website',
    label: 'Publish your website',
    href: '/console/website',
    description: 'Turn on your public organization website.',
  },
  {
    key: 'open_registration',
    label: 'Open registration',
    href: '/console/programs',
    description: 'Let families register for a program.',
  },
] as const;

export type OnboardingKey = (typeof ONBOARDING_ITEMS)[number]['key'];

export interface OnboardingItem {
  key: OnboardingKey;
  label: string;
  href: string;
  description: string;
  state: 'pending' | 'complete' | 'dismissed';
  completedAt: string | null;
  dismissedAt: string | null;
}

async function detectCompleted(
  trx: OrgTransaction,
  orgId: string,
): Promise<Set<OnboardingKey>> {
  const done = new Set<OnboardingKey>();
  const payments = await trx
    .selectFrom('payment_accounts')
    .select('id')
    .where('org_id', '=', orgId)
    .where((eb) =>
      eb.or([
        eb('charges_enabled', '=', true),
        eb('onboarding_status', '=', 'complete'),
      ]),
    )
    .executeTakeFirst();
  if (payments) done.add('connect_payments');
  const staff = await trx
    .selectFrom('org_memberships')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (Number(staff?.count ?? 0) > 1) done.add('users_roles');
  const sport = await trx
    .selectFrom('sport_profiles')
    .select('id')
    .where('org_id', '=', orgId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (sport) done.add('choose_sports');
  const program = await trx
    .selectFrom('programs')
    .select('id')
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (program) done.add('create_program');
  const facility = await trx
    .selectFrom('facilities')
    .select('id')
    .where('org_id', '=', orgId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (facility) done.add('add_facilities');
  const requirement = await trx
    .selectFrom('role_credential_requirements')
    .select('id')
    .where('org_id', '=', orgId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (requirement) done.add('configure_compliance');
  const imported = await trx
    .selectFrom('import_batches')
    .select('id')
    .where('org_id', '=', orgId)
    .where('status', '=', 'committed')
    .executeTakeFirst();
  if (imported) {
    done.add('import_members');
  } else {
    const members = await trx
      .selectFrom('people')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('org_id', '=', orgId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (Number(members?.count ?? 0) >= 5) done.add('import_members');
  }
  const org = await trx
    .selectFrom('organizations')
    .select('website_url')
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (org?.website_url) done.add('publish_website');
  const openProgram = await trx
    .selectFrom('programs')
    .select('id')
    .where('org_id', '=', orgId)
    .where(sql<boolean>`registration_opens_at IS NOT NULL AND registration_opens_at <= now()`)
    .where(sql<boolean>`registration_closes_at IS NULL OR registration_closes_at >= now()`)
    .executeTakeFirst();
  if (openProgram) done.add('open_registration');
  return done;
}

async function requireStaff(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  impersonating: boolean,
): Promise<void> {
  if (impersonating) return;
  const member = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', orgId)
    .where('account_id', '=', actorId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!member)
    throw new OnboardingError(404, 'NOT_FOUND', 'Organization not found');
}

export function createOnboardingService(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);

  async function getChecklist(
    orgId: string,
    actorId: string,
    impersonating = false,
  ): Promise<{ items: OnboardingItem[]; completeCount: number }> {
    return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId, impersonating);
      const completed = await detectCompleted(trx, orgId);
      const existing = await trx
        .selectFrom('org_onboarding_items')
        .selectAll()
        .where('org_id', '=', orgId)
        .execute();
      const byKey = new Map(existing.map((row) => [row.key, row]));
      const items: OnboardingItem[] = [];
      for (const meta of ONBOARDING_ITEMS) {
        let row = byKey.get(meta.key);
        const derived = completed.has(meta.key);
        if (!row) {
          const id = newId();
          await trx
            .insertInto('org_onboarding_items')
            .values({
              id,
              org_id: orgId,
              key: meta.key,
              ...(derived
                ? { completed_at: new Date(), completed_by_event: 'detected' }
                : {}),
            })
            .execute();
          row = await trx
            .selectFrom('org_onboarding_items')
            .selectAll()
            .where('org_id', '=', orgId)
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
        } else if (derived && !row.completed_at) {
          await trx
            .updateTable('org_onboarding_items')
            .set({ completed_at: new Date(), completed_by_event: 'detected' })
            .where('org_id', '=', orgId)
            .where('id', '=', row.id)
            .execute();
          row = { ...row, completed_at: new Date() } as typeof row;
        }
        const state = row.dismissed_at
          ? 'dismissed'
          : row.completed_at
            ? 'complete'
            : 'pending';
        items.push({
          key: meta.key as OnboardingKey,
          label: meta.label,
          href: meta.href,
          description: meta.description,
          state,
          completedAt: row.completed_at?.toISOString() ?? null,
          dismissedAt: row.dismissed_at?.toISOString() ?? null,
        });
      }
      return {
        items,
        completeCount: items.filter((item) => item.state !== 'pending').length,
      };
    });
  }

  async function dismiss(
    orgId: string,
    actorId: string,
    key: OnboardingKey,
    impersonating = false,
  ): Promise<void> {
    await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId, impersonating);
      await trx
        .updateTable('org_onboarding_items')
        .set({ dismissed_at: new Date(), dismissed_by: actorId })
        .where('org_id', '=', orgId)
        .where('key', '=', key)
        .where('dismissed_at', 'is', null)
        .execute();
    });
  }

  async function dismissAll(
    orgId: string,
    actorId: string,
    impersonating = false,
  ): Promise<void> {
    await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId, impersonating);
      await trx
        .updateTable('org_onboarding_items')
        .set({ dismissed_at: new Date(), dismissed_by: actorId })
        .where('org_id', '=', orgId)
        .where('dismissed_at', 'is', null)
        .execute();
    });
  }

  async function restore(
    orgId: string,
    actorId: string,
    key: OnboardingKey,
    impersonating = false,
  ): Promise<void> {
    await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId, impersonating);
      await trx
        .updateTable('org_onboarding_items')
        .set({ dismissed_at: null, dismissed_by: null })
        .where('org_id', '=', orgId)
        .where('key', '=', key)
        .execute();
    });
  }

  return { getChecklist, dismiss, dismissAll, restore };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
