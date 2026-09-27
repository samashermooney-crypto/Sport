import { Temporal } from '@js-temporal/polyfill';
import { orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import { checkCompliance } from '@shared/policies/compliance-gate';
import type {
  ComplianceResult,
  CredentialEvidence,
  CredentialRequirement,
} from '@shared/policies/compliance-gate';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { JsonObject } from '../../db/types';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';

export const complianceRoleSchema = z.enum([
  'head_coach',
  'assistant_coach',
  'team_manager',
  'trainer',
  'treasurer',
  'official',
  'volunteer',
  'evaluator',
]);
export type ComplianceRole = z.infer<typeof complianceRoleSchema>;

const appliesToSchema = z.looseObject({
  roles: z.array(z.string()).optional(),
  minimumAge: z.number().int().min(0).max(120).optional(),
});

export class RoleEligibilityError extends Error {
  constructor(readonly result: ComplianceResult) {
    super('The person does not meet the current role requirements');
    this.name = 'RoleEligibilityError';
  }
}

function dateOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

export type EligibilityInput = {
  personId: string;
  role: ComplianceRole;
  programId?: string;
  onDate?: string;
};

export async function evaluateRoleEligibility(
  trx: OrgTransaction,
  context: OrgContext,
  input: EligibilityInput,
  now = new Date(),
): Promise<ComplianceResult> {
  const person = await trx
    .selectFrom('people')
    .innerJoin('organizations', 'organizations.id', 'people.org_id')
    .select(['people.date_of_birth', 'organizations.timezone'])
    .where('people.org_id', '=', context.orgId)
    .where('people.id', '=', input.personId)
    .where('people.status', '=', 'active')
    .executeTakeFirst();
  if (!person) throw new Error('Person not found');

  const configuredRows = await trx
    .selectFrom('role_credential_requirements')
    .innerJoin(
      'credential_types',
      'credential_types.id',
      'role_credential_requirements.credential_type_id',
    )
    .select([
      'role_credential_requirements.credential_type_id as typeId',
      'role_credential_requirements.minimum_age as minimumAge',
      'role_credential_requirements.active as requirementActive',
      'credential_types.active as credentialActive',
      'credential_types.applies_to as appliesTo',
    ])
    .where('role_credential_requirements.org_id', '=', context.orgId)
    .where('role_credential_requirements.role', '=', input.role)
    .where((eb) =>
      eb.or([
        eb('role_credential_requirements.scope_type', '=', 'org'),
        ...(input.programId
          ? [
              eb.and([
                eb('role_credential_requirements.scope_type', '=', 'program'),
                eb(
                  'role_credential_requirements.scope_id',
                  '=',
                  input.programId,
                ),
              ]),
            ]
          : []),
      ]),
    )
    .execute();

  const rows = configuredRows.filter(
    (row) => row.requirementActive && row.credentialActive,
  );

  let applicable = rows;
  if (configuredRows.length === 0) {
    const defaults = await trx
      .selectFrom('credential_types')
      .select(['id as typeId', 'applies_to as appliesTo'])
      .where((eb) =>
        eb.or([eb('org_id', 'is', null), eb('org_id', '=', context.orgId)]),
      )
      .where('active', '=', true)
      .where('blocks_activation', '=', true)
      .execute();
    applicable = defaults.flatMap((credential) => {
      const parsed = appliesToSchema.safeParse(credential.appliesTo);
      if (!parsed.success || !parsed.data.roles?.includes(input.role))
        return [];
      return [
        {
          typeId: credential.typeId,
          minimumAge: 18,
          requirementActive: true,
          credentialActive: true,
          appliesTo: credential.appliesTo,
        },
      ];
    });
  }

  const requirements: CredentialRequirement[] = applicable.map((row) => ({
    typeId: row.typeId,
  }));
  const credentials = requirements.length
    ? await trx
        .selectFrom('person_credentials')
        .select(['credential_type_id', 'status', 'expires_on'])
        .where('org_id', '=', context.orgId)
        .where('person_id', '=', input.personId)
        .where(
          'credential_type_id',
          'in',
          requirements.map((requirement) => requirement.typeId),
        )
        .execute()
    : [];
  const evidence: CredentialEvidence[] = credentials.map((credential) => ({
    typeId: credential.credential_type_id,
    status: credential.status as CredentialEvidence['status'],
    expiresOn: dateOnly(credential.expires_on),
  }));
  const onDate =
    input.onDate ??
    orgToday(
      person.timezone,
      Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    );
  const minimumAge = Math.max(
    18,
    ...applicable.map((row) => {
      const parsed = appliesToSchema.safeParse(row.appliesTo);
      return Math.max(
        row.minimumAge,
        parsed.success ? (parsed.data.minimumAge ?? 0) : 0,
      );
    }),
  );

  const override = await trx
    .selectFrom('compliance_overrides')
    .select(['reason', 'granted_on', 'expires_on'])
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', input.personId)
    .where('role', '=', input.role)
    .where('revoked_at', 'is', null)
    .where('granted_on', '<=', sql<Date>`${onDate}::date`)
    .where('expires_on', '>=', sql<Date>`${onDate}::date`)
    .where((eb) =>
      eb.or([
        eb('scope_type', '=', 'org'),
        ...(input.programId
          ? [
              eb.and([
                eb('scope_type', '=', 'program'),
                eb('scope_id', '=', input.programId),
              ]),
            ]
          : []),
      ]),
    )
    .orderBy('expires_on', 'desc')
    .executeTakeFirst();

  return checkCompliance({
    requirements,
    credentials: evidence,
    dateOfBirth: dateOnly(person.date_of_birth) ?? '',
    minimumAge,
    onDate,
    override: override
      ? {
          ownerApproved: true,
          reason: override.reason,
          grantedOn: dateOnly(override.granted_on) ?? '',
          expiresOn: dateOnly(override.expires_on) ?? '',
        }
      : null,
  });
}

/** This is the integration point for team, official, volunteer and evaluator flows. */
export async function assertEligibleForRole(
  database: Kysely<DB>,
  context: OrgContext,
  input: EligibilityInput,
  now = new Date(),
): Promise<ComplianceResult> {
  const withOrg = createWithOrg(database);
  const result = await withOrg(context, (trx) =>
    evaluateRoleEligibility(trx, context, input, now),
  );
  if (!result.eligible) throw new RoleEligibilityError(result);
  return result;
}

export async function logEligibilityAudit(
  trx: OrgTransaction,
  context: OrgContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      org_id: context.orgId,
      actor_account_id: context.actor.accountId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      changes: details as JsonObject,
    })
    .execute();
}
