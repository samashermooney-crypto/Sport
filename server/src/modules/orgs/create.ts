import { newId } from '@shared/ids';
import { createOrgSchema } from '@shared/schemas/orgs';
import type { CreateOrgInput } from '@shared/schemas/orgs';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { withOrgInTransaction } from '../../db/withOrg';

export class OrgCreationError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'FORBIDDEN' | 'VALIDATION_ERROR',
    message: string,
  ) {
    super(message);
  }
}

const credentialDefaults = [
  {
    key: 'background_check',
    name: 'Background check',
    verification: 'manual_staff',
  },
  {
    key: 'safesport_training',
    name: 'SafeSport training',
    verification: 'document_upload',
  },
  {
    key: 'concussion_training',
    name: 'Concussion training',
    verification: 'document_upload',
  },
  {
    key: 'coaching_license',
    name: 'Coaching license',
    verification: 'document_upload',
  },
] as const;

function seasonYear(now: Date, timezone: string): number {
  const year = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    timeZone: timezone,
  }).format(now);
  return Number(year);
}

export async function createOrganization(
  database: Kysely<DB>,
  accountId: string,
  input: CreateOrgInput,
  now: Date,
): Promise<{ id: string; slug: string; status: 'onboarding' }> {
  const parsed = createOrgSchema.parse(input);
  try {
    return await database.transaction().execute(async (trx) => {
      const account = await trx
        .selectFrom('accounts')
        .select(['id', 'email_verified_at', 'status'])
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (
        !account ||
        account.status !== 'active' ||
        !account.email_verified_at
      ) {
        throw new OrgCreationError(
          'FORBIDDEN',
          'Verify your email before creating an organization',
        );
      }
      const plan = await trx
        .selectFrom('plans')
        .select(['id', 'application_fee_bps', 'application_fee_fixed_cents'])
        .where('key', '=', 'starter')
        .where('active', '=', true)
        .executeTakeFirst();
      if (!plan) throw new Error('Starter plan is unavailable');
      const templates = await trx
        .selectFrom('sport_templates')
        .select(['key', 'name', 'profile'])
        .where('key', 'in', parsed.sportKeys)
        .execute();
      if (templates.length !== parsed.sportKeys.length) {
        throw new OrgCreationError(
          'VALIDATION_ERROR',
          'Choose supported sports',
        );
      }
      const factor = await trx
        .selectFrom('mfa_factors')
        .select('id')
        .where('account_id', '=', accountId)
        .where('confirmed_at', 'is not', null)
        .executeTakeFirst();

      const orgId = newId();
      await trx
        .insertInto('organizations')
        .values({
          id: orgId,
          slug: parsed.slug,
          name: parsed.name,
          kind: parsed.kind,
          timezone: parsed.timezone,
          address: parsed.address,
          plan_id: plan.id,
          application_fee_bps: plan.application_fee_bps,
          application_fee_fixed_cents: plan.application_fee_fixed_cents,
          status: 'onboarding',
          settings: {
            coachMedicalAccess: 'flags_only',
            mediaConsentDefault: false,
            serviceFeePassThrough: false,
            registrationApprovalRequired: false,
            communicationsOptInDefault: false,
            peopleSchoolYearCutoff: '08-01',
          },
        })
        .execute();

      await withOrgInTransaction(
        trx,
        {
          orgId,
          actor: { accountId },
        },
        async (scoped) => {
          await scoped
            .insertInto('org_memberships')
            .values({
              id: newId(),
              org_id: orgId,
              account_id: accountId,
              status: 'active',
              joined_at: now,
            })
            .execute();
          await scoped
            .insertInto('role_assignments')
            .values({
              id: newId(),
              org_id: orgId,
              account_id: accountId,
              role: 'owner',
              scope_type: 'org',
              scope_id: null,
              granted_by: accountId,
              pending_mfa: !factor,
            })
            .execute();
          await scoped
            .insertInto('sport_profiles')
            .values(
              templates.map((template) => ({
                id: newId(),
                org_id: orgId,
                template_key: template.key,
                name: template.name,
                profile: template.profile,
              })),
            )
            .execute();
          const year = seasonYear(now, parsed.timezone);
          await scoped
            .insertInto('seasons')
            .values({
              id: newId(),
              org_id: orgId,
              name: `${String(year)} Season`,
              starts_on: `${String(year)}-01-01`,
              ends_on: `${String(year)}-12-31`,
              status: 'planning',
            })
            .execute();
          await scoped
            .insertInto('credential_types')
            .values(
              credentialDefaults.map((item) => ({
                id: newId(),
                org_id: orgId,
                key: item.key,
                name: item.name,
                description: null,
                verification: item.verification,
                provider: null,
                validity: { months: 12 },
                applies_to: {
                  roles: [
                    'head_coach',
                    'assistant_coach',
                    'team_manager',
                    'official',
                    'volunteer',
                  ],
                },
                blocks_activation: true,
              })),
            )
            .execute();
          await scoped
            .insertInto('form_definitions')
            .values([
              {
                id: newId(),
                org_id: orgId,
                scope: 'person_profile',
                name: 'Athlete profile',
                owner_type: 'org',
                owner_id: null,
                schema: {
                  sections: [
                    { key: 'identity', fields: ['name', 'dateOfBirth'] },
                    {
                      key: 'emergencyContact',
                      fields: ['name', 'phone', 'relationship'],
                    },
                    {
                      key: 'medical',
                      fields: [
                        'allergies',
                        'conditions',
                        'medications',
                        'physician',
                      ],
                    },
                  ],
                },
              },
              {
                id: newId(),
                org_id: orgId,
                scope: 'person_profile',
                name: 'Guardian contact',
                owner_type: 'org',
                owner_id: null,
                schema: {
                  sections: [
                    {
                      key: 'guardian',
                      fields: ['name', 'email', 'phone', 'relationship'],
                    },
                  ],
                },
              },
            ])
            .execute();
          await scoped
            .insertInto('waiver_documents')
            .values({
              id: newId(),
              org_id: orgId,
              name: 'Draft — replace with your own reviewed text',
              body_html:
                '<p>Draft — replace with your own reviewed text before publishing.</p>',
              requires: 'guardian_if_minor',
              renewal: 'every_registration',
              template_unreviewed: true,
            })
            .execute();
          await scoped
            .insertInto('audit_log')
            .values({
              id: newId(),
              org_id: orgId,
              actor_account_id: accountId,
              action: 'organization.created',
              entity_type: 'organization',
              entity_id: orgId,
              changes: { slug: parsed.slug, kind: parsed.kind },
            })
            .execute();
        },
      );
      return { id: orgId, slug: parsed.slug, status: 'onboarding' as const };
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'organizations_slug_key'
    ) {
      throw new OrgCreationError('CONFLICT', 'This URL is already in use');
    }
    throw error;
  }
}
