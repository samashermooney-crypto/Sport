import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { canAdjudicateIneligible } from '@shared/policies/fcra-timeline';
import { sql, type Kysely } from 'kysely';

import type { DB, JsonObject } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { ManualBackgroundCheckProvider } from '../../integrations/background-check/provider';
import type { BackgroundCheckProvider } from '../../integrations/background-check/provider';
import type { EmailSender } from '../../integrations/email/sender';
import { decryptRestricted, encryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';

import { evaluateRoleEligibility, logEligibilityAudit } from './policy';
import type { ComplianceRole } from './policy';

export interface ComplianceDependencies {
  database: Kysely<DB>;
  encryption: EncryptionKeys;
  email: EmailSender;
  providers: {
    manual: BackgroundCheckProvider;
    checkr?: BackgroundCheckProvider;
  };
  checkrEnabled: boolean;
  checkrWebhookSecret?: string;
  clock: () => Date;
  appUrl: string;
}

export class ComplianceServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function todayForTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string => {
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) throw new Error(`Date formatter omitted ${type}`);
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dateOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

export function auditRestrictedRead(
  trx: OrgTransaction,
  context: OrgContext,
  entityType: string,
  entityId: string,
  fields: string[],
): Promise<void> {
  return logEligibilityAudit(
    trx,
    context,
    'restricted.read',
    entityType,
    entityId,
    {
      fields,
    },
  );
}

async function notifyAccounts(
  trx: OrgTransaction,
  context: OrgContext,
  accountIds: readonly string[],
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const accountId of new Set(accountIds)) {
    await trx
      .insertInto('notifications')
      .values({
        id: newId(),
        org_id: context.orgId,
        account_id: accountId,
        type,
        payload: payload as JsonObject,
      })
      .execute();
  }
}

async function teamAccountIdsForPerson(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('team_staff as staff')
    .innerJoin('team_staff as directors', (join) =>
      join
        .onRef('directors.org_id', '=', 'staff.org_id')
        .onRef('directors.team_season_id', '=', 'staff.team_season_id'),
    )
    .innerJoin('person_account_links as links', (join) =>
      join
        .onRef('links.org_id', '=', 'directors.org_id')
        .onRef('links.person_id', '=', 'directors.person_id'),
    )
    .select('links.account_id')
    .where('staff.org_id', '=', orgId)
    .where('staff.person_id', '=', personId)
    .where('staff.status', '=', 'active')
    .where('directors.status', '=', 'active')
    .where('links.revoked_at', 'is', null)
    .where('account_id', 'is not', null)
    .execute();
  return rows.map((row) => row.account_id);
}

async function notifyCredentialStatus(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
  credentialId: string,
  type: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const self = await trx
    .selectFrom('person_account_links')
    .select('account_id')
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .where('relationship', '=', 'self')
    .where('revoked_at', 'is', null)
    .execute();
  const roleAccounts = await trx
    .selectFrom('role_assignments')
    .select('account_id')
    .where('org_id', '=', context.orgId)
    .where('role', '=', 'compliance')
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  const teamAccounts = await teamAccountIdsForPerson(
    trx,
    context.orgId,
    personId,
  );
  await notifyAccounts(
    trx,
    context,
    [
      ...self.map((row) => row.account_id),
      ...teamAccounts,
      ...roleAccounts.map((row) => row.account_id),
    ],
    type,
    { personId, credentialId, ...extra },
  );
}

export async function listCredentialTypes(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('credential_types')
      .select([
        'id',
        'key',
        'name',
        'description',
        'verification',
        'provider',
        'validity',
        'applies_to',
        'blocks_activation',
        'renewal_reminder_days',
        'active',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .orderBy('name')
      .execute(),
  );
}

export async function updateCredentialType(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    id: string;
    name: string;
    description: string | null;
    validity:
      { months: number } | { expires_on_month_day: string } | { never: true };
    blocksActivation: boolean;
    renewalReminderDays: number[];
    active: boolean;
    version: number;
  },
) {
  if ('expires_on_month_day' in input.validity) {
    const match = /^(\d{2})-(\d{2})$/.exec(input.validity.expires_on_month_day);
    if (!match)
      throw new ComplianceServiceError(
        400,
        'VALIDITY_INVALID',
        'Credential validity is not configured',
      );
    try {
      Temporal.PlainDate.from({
        year: 2000,
        month: Number(match[1]),
        day: Number(match[2]),
      });
    } catch {
      throw new ComplianceServiceError(
        400,
        'VALIDITY_INVALID',
        'Choose a real calendar month and day',
      );
    }
  }
  if (
    input.renewalReminderDays
      .slice(1)
      .some(
        (value, index) =>
          value >= (input.renewalReminderDays[index] ?? Infinity),
      )
  )
    throw new ComplianceServiceError(
      400,
      'VALIDATION_ERROR',
      'Reminder days must be unique and ordered from latest to earliest',
    );
  return createWithOrg(database)(context, async (trx) => {
    const existing = await trx
      .selectFrom('credential_types')
      .select(['version', 'verification'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!existing)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Credential type not found',
      );
    if (existing.version !== input.version)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Credential type changed; reload before saving',
      );
    const updated = await trx
      .updateTable('credential_types')
      .set({
        name: input.name,
        description: input.description,
        validity: input.validity as JsonObject,
        blocks_activation: input.blocksActivation,
        renewal_reminder_days: input.renewalReminderDays,
        active: input.active,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.id)
      .where('version', '=', input.version)
      .returning(['id', 'version', 'active'])
      .executeTakeFirst();
    if (!updated)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Credential type changed; reload before saving',
      );
    await logEligibilityAudit(
      trx,
      context,
      'credential_type.updated',
      'credential_type',
      input.id,
      {
        name: input.name,
        description: input.description,
        validity: input.validity,
        blocksActivation: input.blocksActivation,
        renewalReminderDays: input.renewalReminderDays,
        active: input.active,
        verification: existing.verification,
      },
    );
    return updated;
  });
}

export async function listRequirements(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('role_credential_requirements as requirement')
      .innerJoin(
        'credential_types as credential',
        'credential.id',
        'requirement.credential_type_id',
      )
      .select([
        'requirement.id',
        'requirement.role',
        'requirement.credential_type_id as credentialTypeId',
        'credential.name as credentialName',
        'requirement.scope_type as scopeType',
        'requirement.scope_id as scopeId',
        'requirement.minimum_age as minimumAge',
        'requirement.active',
        'requirement.version',
      ])
      .where('requirement.org_id', '=', context.orgId)
      .orderBy('requirement.role')
      .orderBy('credential.name')
      .execute(),
  );
}

export async function saveRequirement(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    id?: string;
    version?: number;
    role: ComplianceRole;
    credentialTypeId: string;
    scopeType: 'org' | 'program';
    scopeId: string | null;
    minimumAge: number;
    active: boolean;
  },
) {
  if ((input.scopeType === 'org') !== (input.scopeId === null))
    throw new ComplianceServiceError(
      400,
      'VALIDATION_ERROR',
      'The requirement scope is invalid',
    );
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const type = await trx
      .selectFrom('credential_types')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialTypeId)
      .executeTakeFirst();
    if (!type)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Credential type not found',
      );
    if (input.scopeId) {
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.scopeId)
        .executeTakeFirst();
      if (!program)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Program not found');
    }
    if (input.id) {
      const existing = await trx
        .selectFrom('role_credential_requirements')
        .select(['id', 'version'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (!existing)
        throw new ComplianceServiceError(
          404,
          'NOT_FOUND',
          'Requirement not found',
        );
      if (existing.version !== input.version)
        throw new ComplianceServiceError(
          409,
          'CONFLICT',
          'Requirement changed; reload before saving',
        );
      const updated = await trx
        .updateTable('role_credential_requirements')
        .set({
          role: input.role,
          credential_type_id: input.credentialTypeId,
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          minimum_age: input.minimumAge,
          active: input.active,
          version: existing.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.id)
        .where('version', '=', existing.version)
        .returning(['id', 'version'])
        .executeTakeFirst();
      if (!updated)
        throw new ComplianceServiceError(
          409,
          'CONFLICT',
          'Requirement changed; reload before saving',
        );
      await logEligibilityAudit(
        trx,
        context,
        'credential_requirement.updated',
        'role_credential_requirement',
        input.id,
        {
          role: input.role,
          credentialTypeId: input.credentialTypeId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          minimumAge: input.minimumAge,
          active: input.active,
        },
      );
      return updated;
    }
    const id = newId();
    await trx
      .insertInto('role_credential_requirements')
      .values({
        id,
        org_id: context.orgId,
        role: input.role,
        credential_type_id: input.credentialTypeId,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        minimum_age: input.minimumAge,
        active: input.active,
      })
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'credential_requirement.created',
      'role_credential_requirement',
      id,
      {
        role: input.role,
        credentialTypeId: input.credentialTypeId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        minimumAge: input.minimumAge,
        active: input.active,
      },
    );
    return { id, version: 1 };
  });
}

async function canAccessPerson(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
): Promise<boolean> {
  return Boolean(
    await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', personId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
}

async function isPersonSelf(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
): Promise<boolean> {
  return Boolean(
    await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', personId)
      .where('account_id', '=', context.actor.accountId)
      .where('relationship', '=', 'self')
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
}

async function validateRestrictedFile(
  trx: OrgTransaction,
  orgId: string,
  fileId: string | null,
  ownerType: string,
  ownerId: string,
): Promise<void> {
  if (!fileId) return;
  const file = await trx
    .selectFrom('files')
    .select([
      'id',
      'sensitivity',
      'upload_state',
      'deleted_at',
      'owner_type',
      'owner_id',
    ])
    .where('org_id', '=', orgId)
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (
    !file ||
    file.sensitivity !== 'restricted' ||
    file.upload_state !== 'complete' ||
    file.deleted_at ||
    file.owner_type !== ownerType ||
    file.owner_id !== ownerId
  )
    throw new ComplianceServiceError(
      400,
      'FILE_INVALID',
      'Use a completed restricted document from this organization',
    );
}

export async function submitCredential(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    personId: string;
    credentialTypeId: string;
    identifier?: string;
    issuedOn?: string | null;
    expiresOn?: string | null;
    fileId?: string | null;
  },
  canManage = false,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    if (
      input.issuedOn &&
      input.expiresOn &&
      Temporal.PlainDate.compare(
        Temporal.PlainDate.from(input.issuedOn),
        Temporal.PlainDate.from(input.expiresOn),
      ) > 0
    )
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'Credential expiry must follow its issue date',
      );
    const credentialType = await trx
      .selectFrom('credential_types')
      .select(['id', 'active'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialTypeId)
      .executeTakeFirst();
    if (!credentialType?.active)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Credential type not found',
      );
    if (!canManage && !(await canAccessPerson(trx, context, input.personId)))
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
    await validateRestrictedFile(
      trx,
      context.orgId,
      input.fileId ?? null,
      'person_credential',
      input.personId,
    );
    const id = newId();
    const identifier = input.identifier?.trim() ?? '';
    await trx
      .insertInto('person_credentials')
      .values({
        id,
        org_id: context.orgId,
        person_id: input.personId,
        credential_type_id: input.credentialTypeId,
        status: 'pending_review',
        identifier_enc: identifier
          ? encryptRestricted(Buffer.from(identifier), dependencies.encryption)
          : null,
        identifier_hint: identifier ? `••••${identifier.slice(-4)}` : null,
        issued_on: input.issuedOn ?? null,
        expires_on: input.expiresOn ?? null,
        file_id: input.fileId ?? null,
      })
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'person_credential.created',
      'person_credential',
      id,
      {
        status: 'pending_review',
        credentialTypeId: input.credentialTypeId,
        identifier: identifier ? '[redacted]' : null,
        fileId: input.fileId ?? null,
      },
    );
    return {
      id,
      status: 'pending_review' as const,
      identifierHint: identifier ? `••••${identifier.slice(-4)}` : null,
    };
  });
}

export async function updateCredentialSubmission(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    credentialId: string;
    identifier?: string;
    issuedOn: string | null;
    expiresOn: string | null;
    fileId: string | null;
    version: number;
  },
  canManage = false,
) {
  if (
    input.issuedOn &&
    input.expiresOn &&
    Temporal.PlainDate.compare(
      Temporal.PlainDate.from(input.issuedOn),
      Temporal.PlainDate.from(input.expiresOn),
    ) > 0
  )
    throw new ComplianceServiceError(
      400,
      'VALIDATION_ERROR',
      'Credential expiry must follow its issue date',
    );
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const existing = await trx
      .selectFrom('person_credentials')
      .select(['id', 'person_id', 'status', 'file_id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialId)
      .executeTakeFirst();
    if (
      !existing ||
      (!canManage && !(await canAccessPerson(trx, context, existing.person_id)))
    )
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Credential not found',
      );
    if (
      existing.status !== 'pending_review' ||
      existing.version !== input.version
    )
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Only a pending credential can be corrected; reload before saving',
      );
    await validateRestrictedFile(
      trx,
      context.orgId,
      input.fileId,
      'person_credential',
      existing.person_id,
    );
    if (existing.file_id)
      await auditRestrictedRead(
        trx,
        context,
        'person_credential',
        existing.id,
        ['file_id'],
      );
    const identifier = input.identifier?.trim();
    const updated = await trx
      .updateTable('person_credentials')
      .set({
        ...(identifier !== undefined
          ? {
              identifier_enc: identifier
                ? encryptRestricted(
                    Buffer.from(identifier),
                    dependencies.encryption,
                  )
                : null,
              identifier_hint: identifier
                ? `••••${identifier.slice(-4)}`
                : null,
            }
          : {}),
        issued_on: input.issuedOn,
        expires_on: input.expiresOn,
        file_id: input.fileId,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialId)
      .where('status', '=', 'pending_review')
      .where('version', '=', input.version)
      .returning(['id', 'version'])
      .executeTakeFirst();
    if (!updated)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Credential changed; reload before saving',
      );
    await logEligibilityAudit(
      trx,
      context,
      'person_credential.corrected',
      'person_credential',
      input.credentialId,
      {
        ...(identifier !== undefined ? { identifier: '[redacted]' } : {}),
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn,
        fileId: input.fileId,
      },
    );
    return { id: input.credentialId, version: updated.version };
  });
}

export async function revokePersonCredential(
  database: Kysely<DB>,
  context: OrgContext,
  input: { credentialId: string; reason: string; version: number },
  canManage = false,
) {
  return createWithOrg(database)(context, async (trx) => {
    const existing = await trx
      .selectFrom('person_credentials')
      .select(['id', 'person_id', 'status', 'file_id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialId)
      .executeTakeFirst();
    if (
      !existing ||
      (!canManage && !(await canAccessPerson(trx, context, existing.person_id)))
    )
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Credential not found',
      );
    if (existing.version !== input.version || existing.status === 'revoked')
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Credential changed; reload before revoking',
      );
    const updated = await trx
      .updateTable('person_credentials')
      .set({ status: 'revoked', version: input.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialId)
      .where('version', '=', input.version)
      .where('status', '=', existing.status)
      .returning(['id'])
      .executeTakeFirst();
    if (!updated)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Credential changed; reload before revoking',
      );
    await logEligibilityAudit(
      trx,
      context,
      'person_credential.revoked',
      'person_credential',
      input.credentialId,
      {
        priorStatus: existing.status,
        reason: input.reason,
      },
    );
    if (existing.status === 'verified') {
      const assignments = await trx
        .selectFrom('team_staff as staff')
        .innerJoin('team_seasons as team', (join) =>
          join
            .onRef('team.org_id', '=', 'staff.org_id')
            .onRef('team.id', '=', 'staff.team_season_id'),
        )
        .select(['staff.id', 'staff.role', 'team.program_id'])
        .where('staff.org_id', '=', context.orgId)
        .where('staff.person_id', '=', existing.person_id)
        .where('staff.status', '=', 'active')
        .execute();
      for (const assignment of assignments) {
        const eligibility = await evaluateRoleEligibility(trx, context, {
          personId: existing.person_id,
          role: assignment.role as ComplianceRole,
          ...(assignment.program_id
            ? { programId: assignment.program_id }
            : {}),
        });
        if (eligibility.eligible) continue;
        await trx
          .updateTable('team_staff')
          .set({
            status: 'pending_compliance',
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', assignment.id)
          .where('status', '=', 'active')
          .execute();
        await notifyCredentialStatus(
          trx,
          context,
          existing.person_id,
          input.credentialId,
          'compliance.role_demoted',
          {
            role: assignment.role,
            assignmentId: assignment.id,
            reason: 'required_credential_revoked',
          },
        );
      }
    }
    if (existing.file_id)
      await auditRestrictedRead(
        trx,
        context,
        'person_credential',
        existing.id,
        ['file_id'],
      );
    await notifyCredentialStatus(
      trx,
      context,
      existing.person_id,
      input.credentialId,
      'compliance.credential_revoked',
    );
    return {
      id: input.credentialId,
      status: 'revoked' as const,
      version: input.version + 1,
    };
  });
}

export async function listPersonCredentials(
  database: Kysely<DB>,
  context: OrgContext,
  personId: string,
  canManage = false,
) {
  return createWithOrg(database)(context, async (trx) => {
    if (!canManage && !(await canAccessPerson(trx, context, personId)))
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
    const rows = await trx
      .selectFrom('person_credentials as credential')
      .innerJoin(
        'credential_types as type',
        'type.id',
        'credential.credential_type_id',
      )
      .select([
        'credential.id',
        'credential.credential_type_id as credentialTypeId',
        'type.name as credentialName',
        'credential.status',
        'credential.identifier_hint as identifierHint',
        'credential.issued_on as issuedOn',
        'credential.expires_on as expiresOn',
        'credential.file_id as fileId',
        'credential.rejection_reason as rejectionReason',
        'credential.version',
      ])
      .where('credential.org_id', '=', context.orgId)
      .where('credential.person_id', '=', personId)
      .orderBy('credential.created_at', 'desc')
      .execute();
    for (const row of rows) {
      await auditRestrictedRead(trx, context, 'person_credential', row.id, [
        'identifier_hint',
        ...(row.fileId ? ['file_id'] : []),
      ]);
    }
    return rows;
  });
}

export async function listCredentialReviewQueue(
  database: Kysely<DB>,
  context: OrgContext,
  status:
    'pending_review' | 'rejected' | 'verified' | 'expired' = 'pending_review',
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('person_credentials as credential')
      .innerJoin(
        'credential_types as type',
        'type.id',
        'credential.credential_type_id',
      )
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'credential.org_id')
          .onRef('person.id', '=', 'credential.person_id'),
      )
      .select([
        'credential.id',
        'credential.person_id as personId',
        'person.first_name as firstName',
        'person.last_name as lastName',
        'credential.credential_type_id as credentialTypeId',
        'type.name as credentialName',
        'credential.status',
        'credential.identifier_hint as identifierHint',
        'credential.issued_on as issuedOn',
        'credential.expires_on as expiresOn',
        'credential.file_id as fileId',
        'credential.rejection_reason as rejectionReason',
        'credential.version',
      ])
      .where('credential.org_id', '=', context.orgId)
      .where('credential.status', '=', status)
      .orderBy('credential.created_at')
      .execute();
    for (const row of rows) {
      await auditRestrictedRead(trx, context, 'person_credential', row.id, [
        'identifier_enc',
        ...(row.fileId ? ['file_id'] : []),
      ]);
    }
    return rows;
  });
}

function computeExpiry(
  validity: unknown,
  issuedOn: string | null,
  now: Date,
  timezone: string,
): string | null {
  const sourceDate = issuedOn ?? todayForTimezone(now, timezone);
  const source = Temporal.PlainDate.from(sourceDate);
  if (validity && typeof validity === 'object' && !Array.isArray(validity)) {
    const data = validity as Record<string, unknown>;
    if (
      typeof data.months === 'number' &&
      Number.isSafeInteger(data.months) &&
      data.months > 0
    )
      return source
        .add({ months: data.months }, { overflow: 'constrain' })
        .toString();
    if (typeof data.expires_on_month_day === 'string') {
      const match = /^(\d{2})-(\d{2})$/.exec(data.expires_on_month_day);
      if (!match)
        throw new ComplianceServiceError(
          400,
          'VALIDITY_INVALID',
          'Credential validity is not configured',
        );
      const month = Number(match[1]);
      const day = Number(match[2]);
      for (let year = source.year; year <= source.year + 8; year += 1) {
        const candidate = Temporal.PlainDate.from(
          { year, month, day },
          { overflow: 'constrain' },
        );
        if (Temporal.PlainDate.compare(candidate, source) >= 0)
          return candidate.toString();
      }
    }
    if (data.never === true || data.kind === 'never') return null;
  }
  throw new ComplianceServiceError(
    400,
    'VALIDITY_INVALID',
    'Credential validity is not configured',
  );
}

export async function reviewCredential(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    credentialId: string;
    decision: 'approve' | 'reject';
    reason?: string;
    version: number;
  },
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const existing = await trx
      .selectFrom('person_credentials as credential')
      .innerJoin(
        'credential_types as type',
        'type.id',
        'credential.credential_type_id',
      )
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'credential.org_id')
          .onRef('person.id', '=', 'credential.person_id'),
      )
      .innerJoin('organizations', 'organizations.id', 'credential.org_id')
      .select([
        'credential.id',
        'credential.person_id',
        'credential.status',
        'credential.issued_on',
        'credential.expires_on as submittedExpiresOn',
        'credential.version',
        'credential.file_id',
        'type.validity',
        'organizations.timezone',
      ])
      .where('credential.org_id', '=', context.orgId)
      .where('credential.id', '=', input.credentialId)
      .executeTakeFirst();
    if (!existing)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Credential not found',
      );
    if (
      existing.version !== input.version ||
      existing.status !== 'pending_review'
    )
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Credential changed; reload before reviewing',
      );
    if (input.decision === 'reject' && !input.reason?.trim())
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'A rejection reason is required',
      );
    if (existing.file_id)
      await auditRestrictedRead(
        trx,
        context,
        'person_credential',
        existing.id,
        ['file_id', 'identifier_enc'],
      );
    const now = dependencies.clock();
    const derivedExpiry =
      input.decision === 'approve'
        ? computeExpiry(
            existing.validity,
            dateOnly(existing.issued_on),
            now,
            existing.timezone,
          )
        : null;
    const submittedExpiry = dateOnly(existing.submittedExpiresOn);
    const expiresOn =
      input.decision !== 'approve'
        ? null
        : derivedExpiry && submittedExpiry
          ? Temporal.PlainDate.compare(
              Temporal.PlainDate.from(derivedExpiry),
              Temporal.PlainDate.from(submittedExpiry),
            ) <= 0
            ? derivedExpiry
            : submittedExpiry
          : (derivedExpiry ?? submittedExpiry);
    const status =
      input.decision === 'reject'
        ? 'rejected'
        : expiresOn &&
            Temporal.PlainDate.compare(
              Temporal.PlainDate.from(expiresOn),
              Temporal.PlainDate.from(todayForTimezone(now, existing.timezone)),
            ) < 0
          ? 'expired'
          : 'verified';
    await trx
      .updateTable('person_credentials')
      .set({
        status,
        expires_on: expiresOn,
        verified_by:
          input.decision === 'approve' ? context.actor.accountId : null,
        verified_at: input.decision === 'approve' ? now : null,
        rejection_reason:
          input.decision === 'reject' ? (input.reason ?? null) : null,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.credentialId)
      .where('version', '=', input.version)
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      `person_credential.${input.decision === 'approve' ? 'verified' : 'rejected'}`,
      'person_credential',
      input.credentialId,
      {
        status,
        reason: input.reason ? '[redacted]' : null,
        expiresOn,
      },
    );
    if (input.decision === 'approve' && status === 'verified')
      await activateEligibleTeamStaff(
        trx,
        context,
        input.credentialId,
        existing.person_id,
        now,
      );
    await notifyCredentialStatus(
      trx,
      context,
      existing.person_id,
      input.credentialId,
      `compliance.credential_${status}`,
    );
    return {
      id: input.credentialId,
      status,
      expiresOn,
      version: input.version + 1,
    };
  });
}

async function activateEligibleTeamStaff(
  trx: OrgTransaction,
  context: OrgContext,
  credentialId: string,
  personId: string,
  now: Date,
): Promise<void> {
  const assignments = await trx
    .selectFrom('team_staff as staff')
    .innerJoin('team_seasons as team', (join) =>
      join
        .onRef('team.org_id', '=', 'staff.org_id')
        .onRef('team.id', '=', 'staff.team_season_id'),
    )
    .select(['staff.id', 'staff.role', 'team.program_id'])
    .where('staff.org_id', '=', context.orgId)
    .where('staff.person_id', '=', personId)
    .where('staff.status', '=', 'pending_compliance')
    .execute();
  for (const assignment of assignments) {
    const result = await evaluateRoleEligibility(
      trx,
      context,
      {
        personId,
        role: assignment.role as ComplianceRole,
        ...(assignment.program_id ? { programId: assignment.program_id } : {}),
      },
      now,
    );
    if (!result.eligible) continue;
    await trx
      .updateTable('team_staff')
      .set({ status: 'active', version: sql<number>`version + 1` })
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignment.id)
      .where('status', '=', 'pending_compliance')
      .execute();
    await notifyCredentialStatus(
      trx,
      context,
      personId,
      credentialId,
      'compliance.role_activated',
      {
        role: assignment.role,
        assignmentId: assignment.id,
        overridden: result.overridden,
      },
    );
  }
}

export async function createComplianceOverride(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    personId: string;
    role: ComplianceRole;
    scopeType: 'org' | 'program';
    scopeId: string | null;
    reason: string;
    expiresOn: string;
  },
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    if ((input.scopeType === 'org') !== (input.scopeId === null))
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'The override scope is invalid',
      );
    if (input.scopeId) {
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.scopeId)
        .executeTakeFirst();
      if (!program)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Program not found');
    }
    const person = await trx
      .selectFrom('people')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.personId)
      .executeTakeFirst();
    if (!person)
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
    const organization = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const now = dependencies.clock();
    const grantedOn = todayForTimezone(now, organization.timezone);
    const expiresOn = Temporal.PlainDate.from(input.expiresOn);
    const granted = Temporal.PlainDate.from(grantedOn);
    if (
      Temporal.PlainDate.compare(expiresOn, granted) < 0 ||
      Temporal.PlainDate.compare(expiresOn, granted.add({ days: 14 })) > 0
    )
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'An override may last at most 14 days',
      );
    const current = await evaluateRoleEligibility(
      trx,
      context,
      {
        personId: input.personId,
        role: input.role,
        ...(input.scopeId ? { programId: input.scopeId } : {}),
        onDate: grantedOn,
      },
      now,
    );
    if (current.missing.some((item) => item.code === 'UNDER_MINIMUM_AGE'))
      throw new ComplianceServiceError(
        409,
        'UNDER_MINIMUM_AGE',
        'An override cannot bypass the role minimum age',
      );
    const id = newId();
    await trx
      .insertInto('compliance_overrides')
      .values({
        id,
        org_id: context.orgId,
        person_id: input.personId,
        role: input.role,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        reason: input.reason,
        approved_by: context.actor.accountId,
        granted_on: grantedOn,
        expires_on: input.expiresOn,
      })
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'compliance.override.created',
      'compliance_override',
      id,
      {
        personId: input.personId,
        role: input.role,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        reason: '[redacted]',
        expiresOn: input.expiresOn,
      },
    );
    return { id, grantedOn, expiresOn: input.expiresOn };
  });
}

export async function getBackgroundSettings(
  database: Kysely<DB>,
  context: OrgContext,
  platformCheckrEnabled: boolean,
) {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const settings = await trx
      .selectFrom('background_check_settings')
      .select([
        'id',
        'provider_mode as providerMode',
        'checkr_enabled as checkrEnabled',
        'volunteer_pays_fee as volunteerPaysFee',
        'package',
        'disclosure_version as disclosureVersion',
        'disclosure_text as disclosureText',
        'authorization_version as authorizationVersion',
        'authorization_text as authorizationText',
        'pre_adverse_notice_text as preAdverseNoticeText',
        'rights_summary_text as rightsSummaryText',
        'adverse_notice_text as adverseNoticeText',
        'fcra_holidays as fcraHolidays',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .executeTakeFirst();
    return {
      settings: settings ?? null,
      options: {
        manual: true,
        checkr: platformCheckrEnabled && Boolean(settings?.checkrEnabled),
      },
    };
  });
}

export async function saveBackgroundSettings(
  database: Kysely<DB>,
  context: OrgContext,
  platformCheckrEnabled: boolean,
  input: {
    providerMode: 'manual' | 'checkr';
    volunteerPaysFee: boolean;
    package: string;
    disclosureVersion: string;
    disclosureText: string;
    authorizationVersion: string;
    authorizationText: string;
    preAdverseNoticeText: string;
    rightsSummaryText: string;
    adverseNoticeText: string;
    fcraHolidays: string[];
    version?: number;
  },
) {
  if (input.volunteerPaysFee)
    throw new ComplianceServiceError(
      409,
      'INVOICE_UNAVAILABLE',
      'Volunteer-paid background checks require the finance invoice integration',
    );
  if (input.providerMode === 'checkr' && !platformCheckrEnabled)
    throw new ComplianceServiceError(
      409,
      'PROVIDER_UNAVAILABLE',
      'Checkr is not configured by the platform',
    );
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const current = await trx
      .selectFrom('background_check_settings')
      .select(['id', 'version'])
      .where('org_id', '=', context.orgId)
      .executeTakeFirst();
    if (current && current.version !== input.version)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Background-check settings changed; reload before saving',
      );
    const values = {
      provider_mode: input.providerMode,
      checkr_enabled: input.providerMode === 'checkr',
      volunteer_pays_fee: input.volunteerPaysFee,
      package: input.package,
      disclosure_version: input.disclosureVersion,
      disclosure_text: input.disclosureText,
      authorization_version: input.authorizationVersion,
      authorization_text: input.authorizationText,
      pre_adverse_notice_text: input.preAdverseNoticeText,
      rights_summary_text: input.rightsSummaryText,
      adverse_notice_text: input.adverseNoticeText,
      fcra_holidays: input.fcraHolidays,
      version: current ? current.version + 1 : 1,
    };
    if (current) {
      await trx
        .updateTable('background_check_settings')
        .set(values)
        .where('org_id', '=', context.orgId)
        .where('version', '=', current.version)
        .execute();
    } else {
      await trx
        .insertInto('background_check_settings')
        .values({ id: newId(), org_id: context.orgId, ...values })
        .execute();
    }
    await logEligibilityAudit(
      trx,
      context,
      `background_check.settings.${current ? 'updated' : 'created'}`,
      'background_check_settings',
      current?.id ?? context.orgId,
      {
        providerMode: input.providerMode,
        volunteerPaysFee: input.volunteerPaysFee,
        package: input.package,
        disclosureVersion: input.disclosureVersion,
        authorizationVersion: input.authorizationVersion,
        templates: '[redacted]',
      },
    );
    return {
      ...values,
      id: current?.id ?? context.orgId,
      options: {
        manual: true,
        checkr: platformCheckrEnabled && input.providerMode === 'checkr',
      },
    };
  });
}

export async function dashboardSummary(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const [
      pendingCredentials,
      expiredCredentials,
      activeOverrides,
      pendingChecks,
      pendingClearances,
      openIncidents,
      activeInjuries,
    ] = await Promise.all([
      trx
        .selectFrom('person_credentials')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('status', '=', 'pending_review')
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('person_credentials')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('status', '=', 'expired')
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('compliance_overrides')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('revoked_at', 'is', null)
        .where('expires_on', '>=', new Date())
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('background_check_orders')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('adjudication', '=', 'pending')
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('return_to_play_clearances')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('review_status', '=', 'pending_review')
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('incident_reports')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('status', '!=', 'closed')
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('injury_reports')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('status', 'in', ['open', 'return_to_play_pending'])
        .executeTakeFirstOrThrow(),
    ]);
    const [orders, incidents, injuries, clearances, overrides] =
      await Promise.all([
        trx
          .selectFrom('background_check_orders')
          .select('id')
          .where('org_id', '=', context.orgId)
          .execute(),
        trx
          .selectFrom('incident_reports')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('status', '!=', 'closed')
          .execute(),
        trx
          .selectFrom('injury_reports')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('status', 'in', ['open', 'return_to_play_pending'])
          .execute(),
        trx
          .selectFrom('return_to_play_clearances')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('review_status', '=', 'pending_review')
          .execute(),
        trx
          .selectFrom('compliance_overrides')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('revoked_at', 'is', null)
          .execute(),
      ]);
    for (const row of orders)
      await auditRestrictedRead(
        trx,
        context,
        'background_check_order',
        row.id,
        ['status', 'result_summary'],
      );
    for (const row of incidents)
      await auditRestrictedRead(trx, context, 'incident_report', row.id, [
        'status',
        'restricted',
      ]);
    for (const row of injuries)
      await auditRestrictedRead(trx, context, 'injury_report', row.id, [
        'status',
        'is_suspected_concussion',
      ]);
    for (const row of clearances)
      await auditRestrictedRead(
        trx,
        context,
        'return_to_play_clearance',
        row.id,
        ['review_status'],
      );
    for (const row of overrides)
      await auditRestrictedRead(trx, context, 'compliance_override', row.id, [
        'reason',
        'expires_on',
      ]);
    return {
      pendingCredentials: pendingCredentials.count,
      expiredCredentials: expiredCredentials.count,
      activeOverrides: activeOverrides.count,
      pendingBackgroundChecks: pendingChecks.count,
      pendingClearances: pendingClearances.count,
      openIncidents: openIncidents.count,
      activeInjuries: activeInjuries.count,
    };
  });
}

export async function readBackgroundCheckDetails(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  orderId: string,
  canReview = false,
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const row = await trx
      .selectFrom('background_check_orders as order')
      .innerJoin(
        'background_check_settings as settings',
        'settings.org_id',
        'order.org_id',
      )
      .select([
        'order.id',
        'order.person_id',
        'order.details_enc',
        'order.disclosure_text',
        'order.authorization_text',
        'order.disclosure_version',
        'order.authorization_version',
        'order.result_summary',
        'order.status',
        'order.adjudication',
        'order.pre_adverse_notice_delivered_at as pre_adverse_notice_at',
        'order.adverse_notice_delivered_at as adverse_notice_at',
        'order.version',
        'settings.rights_summary_text as rightsSummaryText',
      ])
      .where('order.org_id', '=', context.orgId)
      .where('order.id', '=', orderId)
      .executeTakeFirst();
    if (!row)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Background-check order not found',
      );
    if (!canReview && !(await isPersonSelf(trx, context, row.person_id)))
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Background-check order not found',
      );
    await auditRestrictedRead(trx, context, 'background_check_order', row.id, [
      'details_enc',
      'disclosure_text',
      'authorization_text',
    ]);
    return {
      id: row.id,
      status: row.status,
      disclosureVersion: row.disclosure_version,
      disclosureText: row.disclosure_text,
      authorizationVersion: row.authorization_version,
      authorizationText: row.authorization_text,
      rightsSummaryText: row.rightsSummaryText,
      resultSummary: row.result_summary,
      adjudication: row.adjudication,
      preAdverseNoticeAt: row.pre_adverse_notice_at,
      adverseNoticeAt: row.adverse_notice_at,
      details: row.details_enc
        ? decryptRestricted(row.details_enc, dependencies.encryption).toString(
            'utf8',
          )
        : null,
      version: row.version,
    };
  });
}

export async function listBackgroundChecks(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('background_check_orders as order')
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'order.org_id')
          .onRef('person.id', '=', 'order.person_id'),
      )
      .select([
        'order.id',
        'order.person_id as personId',
        'person.first_name as firstName',
        'person.last_name as lastName',
        'order.provider',
        'order.package',
        'order.status',
        'order.result_summary as resultSummary',
        'order.adjudication',
        'order.completed_at as completedAt',
        'order.pre_adverse_notice_delivered_at as preAdverseNoticeAt',
        'order.adverse_notice_delivered_at as adverseNoticeAt',
        'order.version',
      ])
      .where('order.org_id', '=', context.orgId)
      .orderBy('order.created_at', 'desc')
      .execute();
    for (const row of rows)
      await auditRestrictedRead(
        trx,
        context,
        'background_check_order',
        row.id,
        [
          'status',
          'result_summary',
          'adjudication',
          'pre_adverse_notice_at',
          'adverse_notice_at',
        ],
      );
    return rows;
  });
}

export async function listOwnBackgroundChecks(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const people = await trx
      .selectFrom('person_account_links')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('relationship', '=', 'self')
      .where('revoked_at', 'is', null)
      .execute();
    if (!people.length) return [];
    const rows = await trx
      .selectFrom('background_check_orders')
      .select([
        'id',
        'person_id as personId',
        'status',
        'result_summary as resultSummary',
        'adjudication',
        'pre_adverse_notice_delivered_at as preAdverseNoticeAt',
        'adverse_notice_delivered_at as adverseNoticeAt',
        'version',
        'created_at as createdAt',
      ])
      .where('org_id', '=', context.orgId)
      .where(
        'person_id',
        'in',
        people.map((person) => person.person_id),
      )
      .orderBy('created_at', 'desc')
      .execute();
    for (const row of rows)
      await auditRestrictedRead(
        trx,
        context,
        'background_check_order',
        row.id,
        [
          'status',
          'result_summary',
          'pre_adverse_notice_at',
          'adverse_notice_at',
        ],
      );
    return rows;
  });
}

export async function recordManualResult(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    orderId: string;
    status: 'clear' | 'consider' | 'suspended' | 'canceled' | 'expired';
    resultSummary: 'clear' | 'consider' | 'adverse_action';
    details?: string;
    version: number;
  },
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const row = await trx
      .selectFrom('background_check_orders')
      .select(['id', 'provider', 'provider_report_id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.orderId)
      .executeTakeFirst();
    if (!row)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Background-check order not found',
      );
    if (row.provider !== 'manual')
      throw new ComplianceServiceError(
        409,
        'WRONG_PROVIDER',
        'Only a manual order can be updated here',
      );
    if (row.version !== input.version)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Background-check order changed; reload before saving',
      );
    const now = dependencies.clock();
    const manual = dependencies.providers
      .manual as ManualBackgroundCheckProvider;
    const recorded =
      typeof manual.recordResult === 'function' && row.provider_report_id
        ? manual.recordResult(
            row.provider_report_id,
            input.status,
            now.toISOString(),
          )
        : null;
    await trx
      .updateTable('background_check_orders')
      .set({
        status: recorded?.status ?? input.status,
        result_summary: input.resultSummary,
        details_enc: input.details
          ? encryptRestricted(
              Buffer.from(input.details),
              dependencies.encryption,
            )
          : null,
        completed_at: now,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.orderId)
      .where('version', '=', input.version)
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'background_check.result.recorded',
      'background_check_order',
      input.orderId,
      {
        provider: 'manual',
        status: input.status,
        resultSummary: input.resultSummary,
        details: input.details ? '[redacted]' : null,
      },
    );
    return {
      id: input.orderId,
      status: recorded?.status ?? input.status,
      resultSummary: input.resultSummary,
      version: input.version + 1,
    };
  });
}

export async function beginBackgroundCheck(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    personId: string;
    disclosureVersion: string;
    authorizationVersion: string;
  },
  meta: { ip?: string; userAgent?: string } = {},
) {
  const withOrg = createWithOrg(dependencies.database);
  const prepared = await withOrg(context, async (trx) => {
    if (!(await canAccessPerson(trx, context, input.personId)))
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
    const person = await trx
      .selectFrom('people')
      .innerJoin('organizations', 'organizations.id', 'people.org_id')
      .select([
        'people.id',
        'people.first_name',
        'people.last_name',
        'people.date_of_birth',
        'people.email',
        'organizations.timezone',
      ])
      .where('people.org_id', '=', context.orgId)
      .where('people.id', '=', input.personId)
      .executeTakeFirst();
    if (!person)
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
    const onDate = todayForTimezone(dependencies.clock(), person.timezone);
    const age = Temporal.PlainDate.from(
      dateOnly(person.date_of_birth) ?? '',
    ).until(Temporal.PlainDate.from(onDate), { largestUnit: 'years' }).years;
    if (age < 18)
      throw new ComplianceServiceError(
        403,
        'AGE_RESTRICTED',
        'Background-check consent requires an adult candidate',
      );
    const settings = await trx
      .selectFrom('background_check_settings')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .executeTakeFirst();
    if (
      !settings?.disclosure_text ||
      !settings.authorization_text ||
      !settings.disclosure_version ||
      !settings.authorization_version ||
      !settings.pre_adverse_notice_text ||
      !settings.rights_summary_text ||
      !settings.adverse_notice_text
    )
      throw new ComplianceServiceError(
        409,
        'DISCLOSURE_NOT_CONFIGURED',
        'The organization must configure reviewed background-check disclosure and notice text first',
      );
    if (
      input.disclosureVersion !== settings.disclosure_version ||
      input.authorizationVersion !== settings.authorization_version
    )
      throw new ComplianceServiceError(
        409,
        'DISCLOSURE_CHANGED',
        'Review the current disclosure before authorizing',
      );
    if (
      settings.provider_mode === 'checkr' &&
      (!settings.checkr_enabled || !dependencies.checkrEnabled)
    )
      throw new ComplianceServiceError(
        409,
        'PROVIDER_UNAVAILABLE',
        'Checkr is not configured for this organization',
      );
    const account = await trx
      .selectFrom('person_account_links')
      .innerJoin('accounts', 'accounts.id', 'person_account_links.account_id')
      .select(['accounts.email'])
      .where('person_account_links.org_id', '=', context.orgId)
      .where('person_account_links.person_id', '=', input.personId)
      .where('person_account_links.account_id', '=', context.actor.accountId)
      .where('person_account_links.relationship', '=', 'self')
      .where('person_account_links.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!account)
      throw new ComplianceServiceError(
        403,
        'SELF_CONSENT_REQUIRED',
        'Only the candidate may authorize a background check',
      );
    const id = newId();
    await trx
      .insertInto('background_check_orders')
      .values({
        id,
        org_id: context.orgId,
        person_id: input.personId,
        provider: settings.provider_mode,
        package: settings.package,
        status: 'consent_pending',
        consent_signed_at: dependencies.clock(),
        disclosure_version: settings.disclosure_version,
        disclosure_text: settings.disclosure_text,
        authorization_version: settings.authorization_version,
        authorization_text: settings.authorization_text,
        consent_ip: meta.ip ?? null,
        consent_user_agent: meta.userAgent ?? null,
      })
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'background_check.consent.signed',
      'background_check_order',
      id,
      {
        disclosureVersion: settings.disclosure_version,
        authorizationVersion: settings.authorization_version,
      },
    );
    return { id, person, settings, email: account.email };
  });
  const provider =
    prepared.settings.provider_mode === 'checkr'
      ? dependencies.providers.checkr
      : dependencies.providers.manual;
  if (!provider)
    throw new ComplianceServiceError(
      409,
      'PROVIDER_UNAVAILABLE',
      'The configured background-check provider is unavailable',
    );
  const created = await provider.create({
    candidateId: prepared.id,
    firstName: prepared.person.first_name,
    lastName: prepared.person.last_name,
    email: prepared.email,
    dob: dateOnly(prepared.person.date_of_birth) ?? '',
    package: prepared.settings.package,
  });
  await withOrg(context, async (trx) => {
    await trx
      .updateTable('background_check_orders')
      .set({
        status: 'invited',
        provider_candidate_id: prepared.id,
        provider_report_id: created.providerId,
        version: sql<number>`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', prepared.id)
      .where('status', '=', 'consent_pending')
      .execute();
    if (prepared.settings.provider_mode === 'checkr') {
      await trx
        .insertInto('background_check_provider_index')
        .values({
          provider: 'checkr',
          report_id: created.providerId,
          org_id: context.orgId,
          order_id: prepared.id,
        })
        .execute();
    }
  });
  return {
    id: prepared.id,
    status: 'invited',
    provider: prepared.settings.provider_mode,
  };
}

export async function sendPreAdverseNotice(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  orderId: string,
) {
  const prepared = await createWithOrg(dependencies.database)(
    context,
    async (trx) => {
      const order = await trx
        .selectFrom('background_check_orders as order')
        .innerJoin(
          'background_check_settings as settings',
          'settings.org_id',
          'order.org_id',
        )
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'order.org_id')
            .onRef('person.id', '=', 'order.person_id'),
        )
        .select([
          'order.id',
          'order.person_id',
          'order.status',
          'order.result_summary',
          'order.pre_adverse_notice_at',
          'order.pre_adverse_notice_delivered_at',
          'settings.pre_adverse_notice_text',
          'settings.rights_summary_text',
          'settings.fcra_holidays',
          'person.email',
          'person.first_name',
          'person.last_name',
          'person.org_id',
        ])
        .where('order.org_id', '=', context.orgId)
        .where('order.id', '=', orderId)
        .executeTakeFirst();
      if (!order)
        throw new ComplianceServiceError(
          404,
          'NOT_FOUND',
          'Background-check order not found',
        );
      await auditRestrictedRead(
        trx,
        context,
        'background_check_order',
        order.id,
        ['result_summary', 'pre_adverse_notice_at'],
      );
      if (
        order.result_summary !== 'consider' ||
        !['consider', 'clear'].includes(order.status)
      )
        throw new ComplianceServiceError(
          409,
          'INVALID_STATE',
          'A pre-adverse notice requires a consider result',
        );
      if (
        !order.pre_adverse_notice_text?.trim() ||
        !order.rights_summary_text?.trim()
      )
        throw new ComplianceServiceError(
          409,
          'NOTICE_CONFIGURATION_REQUIRED',
          'Configure the pre-adverse notice and rights summary before sending notices',
        );
      const account = await trx
        .selectFrom('person_account_links')
        .innerJoin('accounts', 'accounts.id', 'person_account_links.account_id')
        .select(['accounts.email'])
        .where('person_account_links.org_id', '=', context.orgId)
        .where('person_account_links.person_id', '=', order.person_id)
        .where('person_account_links.relationship', '=', 'self')
        .where('person_account_links.revoked_at', 'is', null)
        .executeTakeFirst();
      if (!account)
        throw new ComplianceServiceError(
          409,
          'CANDIDATE_ACCOUNT_REQUIRED',
          'The candidate needs an active portal account to receive notices',
        );
      if (order.pre_adverse_notice_delivered_at)
        return {
          existing: true as const,
          order: { ...order, email: account.email },
        };
      const now = order.pre_adverse_notice_at ?? dependencies.clock();
      if (!order.pre_adverse_notice_at) {
        const notified = await trx
          .updateTable('background_check_orders')
          .set({
            pre_adverse_notice_at: now,
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', orderId)
          .where('pre_adverse_notice_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!notified)
          throw new ComplianceServiceError(
            409,
            'CONFLICT',
            'A pre-adverse notice was recorded concurrently',
          );
        await logEligibilityAudit(
          trx,
          context,
          'background_check.pre_adverse_notice.queued',
          'background_check_order',
          orderId,
          { candidateEmail: '[redacted]' },
        );
      }
      return {
        existing: false as const,
        order: {
          ...order,
          email: account.email,
          pre_adverse_notice_at: now,
          pre_adverse_notice_text: order.pre_adverse_notice_text,
          rights_summary_text: order.rights_summary_text,
        },
      };
    },
  );
  if (!prepared.existing) {
    await dependencies.email.send({
      to: prepared.order.email,
      subject: 'Important information about your background check',
      text: `${prepared.order.first_name},\n\n${prepared.order.pre_adverse_notice_text}\n\n${prepared.order.rights_summary_text}\n\nView your report and submit a dispute through ${dependencies.appUrl}/me/safety/background-checks/${orderId}. Do not reply to this message with sensitive information.`,
      kind: 'transactional',
      idempotencyKey: `fcra-pre-adverse:${orderId}`,
    });
    await createWithOrg(dependencies.database)(context, async (trx) => {
      await trx
        .updateTable('background_check_orders')
        .set({ pre_adverse_notice_delivered_at: dependencies.clock() })
        .where('org_id', '=', context.orgId)
        .where('id', '=', orderId)
        .where('pre_adverse_notice_delivered_at', 'is', null)
        .execute();
      await logEligibilityAudit(
        trx,
        context,
        'background_check.pre_adverse_notice.sent',
        'background_check_order',
        orderId,
        { candidateEmail: '[redacted]' },
      );
    });
  }
  return {
    id: orderId,
    preAdverseNoticeAt: prepared.order.pre_adverse_notice_at,
    delivered: !prepared.existing,
  };
}

export async function submitBackgroundCheckDispute(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  orderId: string,
  statement: string,
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const order = await trx
      .selectFrom('background_check_orders')
      .select([
        'id',
        'person_id',
        'result_summary',
        'adjudication',
        'pre_adverse_notice_at',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order || !(await isPersonSelf(trx, context, order.person_id)))
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Background-check order not found',
      );
    if (
      order.result_summary !== 'consider' ||
      !order.pre_adverse_notice_at ||
      order.adjudication !== 'pending'
    )
      throw new ComplianceServiceError(
        409,
        'INVALID_STATE',
        'A dispute is available after a pre-adverse notice and before a final decision',
      );
    await auditRestrictedRead(
      trx,
      context,
      'background_check_order',
      order.id,
      ['result_summary', 'pre_adverse_notice_at'],
    );
    const existing = await trx
      .selectFrom('background_check_disputes')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('order_id', '=', orderId)
      .where('candidate_account_id', '=', context.actor.accountId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (existing)
      throw new ComplianceServiceError(
        409,
        'DISPUTE_EXISTS',
        'An open dispute is already on file',
      );
    const id = newId();
    await trx
      .insertInto('background_check_disputes')
      .values({
        id,
        org_id: context.orgId,
        order_id: orderId,
        candidate_account_id: context.actor.accountId,
        statement_enc: encryptRestricted(
          Buffer.from(statement),
          dependencies.encryption,
        ),
        submitted_at: dependencies.clock(),
      })
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'background_check.dispute.submitted',
      'background_check_dispute',
      id,
      {
        orderId,
        statement: '[redacted]',
      },
    );
    const officers = await trx
      .selectFrom('role_assignments')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('role', 'in', ['owner', 'compliance'])
      .where('scope_type', '=', 'org')
      .where('revoked_at', 'is', null)
      .where('pending_mfa', '=', false)
      .execute();
    await notifyAccounts(
      trx,
      context,
      officers.map((officer) => officer.account_id),
      'compliance.background_check_dispute_submitted',
      { orderId, disputeId: id },
    );
    return { id, status: 'open' as const, submittedAt: dependencies.clock() };
  });
}

export async function listBackgroundCheckDisputes(
  dependencies: ComplianceDependencies,
  context: OrgContext,
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('background_check_disputes as dispute')
      .innerJoin('background_check_orders as order', (join) =>
        join
          .onRef('order.org_id', '=', 'dispute.org_id')
          .onRef('order.id', '=', 'dispute.order_id'),
      )
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'order.org_id')
          .onRef('person.id', '=', 'order.person_id'),
      )
      .select([
        'dispute.id',
        'dispute.order_id as orderId',
        'order.person_id as personId',
        'person.first_name as firstName',
        'person.last_name as lastName',
        'dispute.status',
        'dispute.submitted_at as submittedAt',
        'dispute.version',
        'dispute.statement_enc as statementEnc',
      ])
      .where('dispute.org_id', '=', context.orgId)
      .where('dispute.status', '=', 'open')
      .orderBy('dispute.submitted_at')
      .execute();
    for (const row of rows)
      await auditRestrictedRead(
        trx,
        context,
        'background_check_dispute',
        row.id,
        ['statement_enc'],
      );
    return rows.map(({ statementEnc, ...row }) => ({
      ...row,
      statement: decryptRestricted(
        statementEnc,
        dependencies.encryption,
      ).toString('utf8'),
    }));
  });
}

export async function listOwnBackgroundCheckDisputes(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  orderId: string,
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const order = await trx
      .selectFrom('background_check_orders')
      .select(['id', 'person_id'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order || !(await isPersonSelf(trx, context, order.person_id)))
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Background-check order not found',
      );
    const rows = await trx
      .selectFrom('background_check_disputes')
      .select([
        'id',
        'status',
        'submitted_at as submittedAt',
        'resolved_at as resolvedAt',
        'statement_enc as statementEnc',
        'resolution_enc as resolutionEnc',
      ])
      .where('org_id', '=', context.orgId)
      .where('order_id', '=', orderId)
      .where('candidate_account_id', '=', context.actor.accountId)
      .orderBy('submitted_at', 'desc')
      .execute();
    for (const row of rows)
      await auditRestrictedRead(
        trx,
        context,
        'background_check_dispute',
        row.id,
        ['statement_enc', 'resolution_enc'],
      );
    return rows.map(({ statementEnc, resolutionEnc, ...row }) => ({
      ...row,
      statement: decryptRestricted(
        statementEnc,
        dependencies.encryption,
      ).toString('utf8'),
      resolution: resolutionEnc
        ? decryptRestricted(resolutionEnc, dependencies.encryption).toString(
            'utf8',
          )
        : null,
    }));
  });
}

export async function resolveBackgroundCheckDispute(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: { disputeId: string; resolution: string; version: number },
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const dispute = await trx
      .selectFrom('background_check_disputes')
      .select(['id', 'order_id', 'status', 'version', 'statement_enc'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.disputeId)
      .executeTakeFirst();
    if (!dispute)
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Dispute not found');
    if (dispute.status !== 'open' || dispute.version !== input.version)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Dispute changed; reload before resolving',
      );
    await auditRestrictedRead(
      trx,
      context,
      'background_check_dispute',
      dispute.id,
      ['statement_enc'],
    );
    const now = dependencies.clock();
    const updated = await trx
      .updateTable('background_check_disputes')
      .set({
        status: 'resolved',
        resolution_enc: encryptRestricted(
          Buffer.from(input.resolution),
          dependencies.encryption,
        ),
        resolved_by: context.actor.accountId,
        resolved_at: now,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.disputeId)
      .where('version', '=', input.version)
      .where('status', '=', 'open')
      .returning('id')
      .executeTakeFirst();
    if (!updated)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Dispute changed; reload before resolving',
      );
    await logEligibilityAudit(
      trx,
      context,
      'background_check.dispute.resolved',
      'background_check_dispute',
      input.disputeId,
      {
        orderId: dispute.order_id,
        statement: '[redacted]',
        resolution: '[redacted]',
      },
    );
    return {
      id: input.disputeId,
      status: 'resolved' as const,
      resolvedAt: now,
      version: input.version + 1,
    };
  });
}

export async function adjudicateBackgroundCheck(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    orderId: string;
    adjudication: 'eligible' | 'ineligible';
    reason: string;
    version: number;
  },
) {
  const outcome = await createWithOrg(dependencies.database)(
    context,
    async (trx) => {
      const order = await trx
        .selectFrom('background_check_orders as order')
        .innerJoin(
          'background_check_settings as settings',
          'settings.org_id',
          'order.org_id',
        )
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'order.org_id')
            .onRef('person.id', '=', 'order.person_id'),
        )
        .select([
          'order.id',
          'order.person_id',
          'order.result_summary',
          'order.pre_adverse_notice_delivered_at as pre_adverse_notice_at',
          'order.version',
          'order.credential_id',
          'order.adjudication',
          'settings.fcra_holidays',
          'settings.adverse_notice_text',
          'person.first_name',
          'person.last_name',
        ])
        .where('order.org_id', '=', context.orgId)
        .where('order.id', '=', input.orderId)
        .executeTakeFirst();
      if (!order)
        throw new ComplianceServiceError(
          404,
          'NOT_FOUND',
          'Background-check order not found',
        );
      if (order.version !== input.version)
        throw new ComplianceServiceError(
          409,
          'CONFLICT',
          'Background-check order changed; reload before adjudicating',
        );
      if (order.adjudication !== 'pending')
        throw new ComplianceServiceError(
          409,
          'INVALID_STATE',
          'This background check has already been adjudicated',
        );
      await auditRestrictedRead(
        trx,
        context,
        'background_check_order',
        order.id,
        ['result_summary', 'pre_adverse_notice_at'],
      );
      let candidateEmail: string | null = null;
      let adverseNoticeText: string | null = null;
      if (input.adjudication === 'ineligible') {
        if (order.result_summary !== 'consider' || !order.pre_adverse_notice_at)
          throw new ComplianceServiceError(
            409,
            'PRE_ADVERSE_REQUIRED',
            'A consider result requires a pre-adverse notice before an ineligible decision',
          );
        if (!order.adverse_notice_text?.trim())
          throw new ComplianceServiceError(
            409,
            'NOTICE_CONFIGURATION_REQUIRED',
            'Configure the final adverse notice before adjudicating this report',
          );
        adverseNoticeText = order.adverse_notice_text;
        const preAdverseDate = dateOnly(order.pre_adverse_notice_at) ?? '';
        const localToday = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', context.orgId)
          .executeTakeFirstOrThrow()
          .then((org) => todayForTimezone(dependencies.clock(), org.timezone));
        const holidays = order.fcra_holidays.map(
          (item) => dateOnly(item) ?? '',
        );
        if (!canAdjudicateIneligible(preAdverseDate, localToday, holidays))
          throw new ComplianceServiceError(
            409,
            'FCRA_WAIT_REQUIRED',
            'Wait five business days after the pre-adverse notice before an adverse decision',
          );
        const openDispute = await trx
          .selectFrom('background_check_disputes')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('order_id', '=', order.id)
          .where('status', '=', 'open')
          .executeTakeFirst();
        if (openDispute)
          throw new ComplianceServiceError(
            409,
            'DISPUTE_PENDING',
            'Resolve the candidate dispute before a final adverse decision',
          );
        const candidate = await trx
          .selectFrom('person_account_links')
          .innerJoin(
            'accounts',
            'accounts.id',
            'person_account_links.account_id',
          )
          .select(['accounts.email'])
          .where('person_account_links.org_id', '=', context.orgId)
          .where('person_account_links.person_id', '=', order.person_id)
          .where('person_account_links.relationship', '=', 'self')
          .where('person_account_links.revoked_at', 'is', null)
          .executeTakeFirst();
        if (!candidate)
          throw new ComplianceServiceError(
            409,
            'CANDIDATE_ACCOUNT_REQUIRED',
            'The candidate must have an active portal account for final adverse notice',
          );
        candidateEmail = candidate.email;
      }
      const now = dependencies.clock();
      const updated = await trx
        .updateTable('background_check_orders')
        .set({
          adjudication: input.adjudication,
          adjudicated_by: context.actor.accountId,
          adjudicated_at: now,
          adverse_notice_at: input.adjudication === 'ineligible' ? now : null,
          version: input.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.orderId)
        .where('version', '=', input.version)
        .returning('id')
        .executeTakeFirst();
      if (!updated)
        throw new ComplianceServiceError(
          409,
          'CONFLICT',
          'Background-check order changed; reload before adjudicating',
        );
      await trx
        .insertInto('background_check_adjudication_events')
        .values({
          id: newId(),
          org_id: context.orgId,
          order_id: input.orderId,
          adjudication: input.adjudication,
          reason_enc: encryptRestricted(
            Buffer.from(input.reason),
            dependencies.encryption,
          ),
          actor_account_id: context.actor.accountId,
          action_at: now,
        })
        .execute();
      await logEligibilityAudit(
        trx,
        context,
        'background_check.adjudicated',
        'background_check_order',
        input.orderId,
        { adjudication: input.adjudication, reason: '[redacted]' },
      );
      let notice: { email: string; firstName: string; body: string } | null =
        null;
      if (input.adjudication === 'ineligible') {
        if (candidateEmail && adverseNoticeText) {
          notice = {
            email: candidateEmail,
            firstName: order.first_name,
            body: `${adverseNoticeText}\n\nQuestions and dispute submissions: ${dependencies.appUrl}/me/safety/background-checks/${input.orderId}.`,
          };
          await notifyAccounts(
            trx,
            context,
            [context.actor.accountId],
            'compliance.background_check_adjudicated',
            {
              orderId: input.orderId,
              adjudication: input.adjudication,
              candidatePortalUrl: `${dependencies.appUrl}/me/safety/background-checks/${input.orderId}`,
            },
          );
          const selfLinks = await trx
            .selectFrom('person_account_links')
            .select('account_id')
            .where('org_id', '=', context.orgId)
            .where('person_id', '=', order.person_id)
            .where('relationship', '=', 'self')
            .where('revoked_at', 'is', null)
            .execute();
          await notifyAccounts(
            trx,
            context,
            selfLinks.map((link) => link.account_id),
            'compliance.background_check_adverse_notice',
            {
              orderId: input.orderId,
              noticeText: adverseNoticeText,
              portalUrl: `${dependencies.appUrl}/me/safety/background-checks/${input.orderId}`,
            },
          );
        }
      }
      if (order.credential_id && input.adjudication === 'ineligible') {
        await trx
          .updateTable('person_credentials')
          .set({ status: 'revoked', version: sql<number>`version + 1` })
          .where('org_id', '=', context.orgId)
          .where('id', '=', order.credential_id)
          .execute();
      }
      return {
        result: {
          id: input.orderId,
          adjudication: input.adjudication,
          adjudicatedAt: now,
        },
        notice,
      };
    },
  );
  if (outcome.notice) {
    await dependencies.email.send({
      to: outcome.notice.email,
      subject: 'Final notice about your background check',
      text: `${outcome.notice.firstName},\n\n${outcome.notice.body}`,
      kind: 'transactional',
      idempotencyKey: `fcra-adverse:${input.orderId}`,
    });
    await createWithOrg(dependencies.database)(context, async (trx) => {
      await trx
        .updateTable('background_check_orders')
        .set({ adverse_notice_delivered_at: dependencies.clock() })
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.orderId)
        .where('adverse_notice_delivered_at', 'is', null)
        .execute();
      await logEligibilityAudit(
        trx,
        context,
        'background_check.adverse_notice.sent',
        'background_check_order',
        input.orderId,
        { candidateEmail: '[redacted]' },
      );
    });
  }
  return outcome.result;
}

export async function resendAdverseActionNotice(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  orderId: string,
) {
  const prepared = await createWithOrg(dependencies.database)(
    context,
    async (trx) => {
      const row = await trx
        .selectFrom('background_check_orders as order')
        .innerJoin(
          'background_check_settings as settings',
          'settings.org_id',
          'order.org_id',
        )
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'order.org_id')
            .onRef('person.id', '=', 'order.person_id'),
        )
        .select([
          'order.id',
          'order.person_id',
          'order.adjudication',
          'order.adverse_notice_at',
          'order.adverse_notice_delivered_at',
          'settings.adverse_notice_text',
          'person.first_name',
        ])
        .where('order.org_id', '=', context.orgId)
        .where('order.id', '=', orderId)
        .executeTakeFirst();
      if (!row || row.adjudication !== 'ineligible' || !row.adverse_notice_at)
        throw new ComplianceServiceError(
          409,
          'INVALID_STATE',
          'A final adverse decision is required before sending its notice',
        );
      if (!row.adverse_notice_text?.trim())
        throw new ComplianceServiceError(
          409,
          'NOTICE_CONFIGURATION_REQUIRED',
          'Configure the final adverse notice before sending it',
        );
      await auditRestrictedRead(
        trx,
        context,
        'background_check_order',
        row.id,
        ['adverse_notice_at'],
      );
      if (row.adverse_notice_delivered_at)
        return { existing: true as const, row, email: '' };
      const candidate = await trx
        .selectFrom('person_account_links')
        .innerJoin('accounts', 'accounts.id', 'person_account_links.account_id')
        .select('accounts.email')
        .where('person_account_links.org_id', '=', context.orgId)
        .where('person_account_links.person_id', '=', row.person_id)
        .where('person_account_links.relationship', '=', 'self')
        .where('person_account_links.revoked_at', 'is', null)
        .executeTakeFirst();
      if (!candidate)
        throw new ComplianceServiceError(
          409,
          'CANDIDATE_ACCOUNT_REQUIRED',
          'The candidate needs an active portal account to receive the final notice',
        );
      return {
        existing: false as const,
        row: { ...row, adverse_notice_text: row.adverse_notice_text },
        email: candidate.email,
      };
    },
  );
  if (prepared.existing) return { id: orderId, delivered: true };
  await dependencies.email.send({
    to: prepared.email,
    subject: 'Final notice about your background check',
    text: `${prepared.row.first_name},\n\n${prepared.row.adverse_notice_text}\n\nQuestions and dispute submissions: ${dependencies.appUrl}/me/safety/background-checks/${orderId}.`,
    kind: 'transactional',
    idempotencyKey: `fcra-adverse:${orderId}`,
  });
  await createWithOrg(dependencies.database)(context, async (trx) => {
    await trx
      .updateTable('background_check_orders')
      .set({ adverse_notice_delivered_at: dependencies.clock() })
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .where('adverse_notice_delivered_at', 'is', null)
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'background_check.adverse_notice.sent',
      'background_check_order',
      orderId,
      { candidateEmail: '[redacted]' },
    );
  });
  return { id: orderId, delivered: true };
}

export async function processCredentialExpiry(
  dependencies: ComplianceDependencies,
  context: OrgContext,
): Promise<{ reminded: number; expired: number; demoted: number }> {
  const now = dependencies.clock();
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const org = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const today = todayForTimezone(now, org.timezone);
    const rows = await trx
      .selectFrom('person_credentials as credential')
      .innerJoin(
        'credential_types as type',
        'type.id',
        'credential.credential_type_id',
      )
      .select([
        'credential.id',
        'credential.person_id',
        'credential.expires_on',
        'credential.status',
        'type.renewal_reminder_days',
      ])
      .where('credential.org_id', '=', context.orgId)
      .where('credential.status', '=', 'verified')
      .where('credential.expires_on', 'is not', null)
      .where(
        'credential.expires_on',
        '<=',
        sql<Date>`${Temporal.PlainDate.from(today).add({ days: 30 }).toString()}::date`,
      )
      .execute();
    let reminded = 0;
    let expired = 0;
    let demoted = 0;
    for (const row of rows) {
      const expiresOn = dateOnly(row.expires_on);
      if (!expiresOn) continue;
      const daysBefore = Temporal.PlainDate.from(today).until(
        Temporal.PlainDate.from(expiresOn),
        { largestUnit: 'days' },
      ).days;
      if (daysBefore < 0) {
        await trx
          .updateTable('person_credentials')
          .set({ status: 'expired', version: sql<number>`version + 1` })
          .where('org_id', '=', context.orgId)
          .where('id', '=', row.id)
          .where('status', '=', 'verified')
          .execute();
        await notifyCredentialStatus(
          trx,
          context,
          row.person_id,
          row.id,
          'compliance.credential_expired',
        );
        const staff = await trx
          .selectFrom('team_staff as assignment')
          .innerJoin('team_seasons as team', (join) =>
            join
              .onRef('team.org_id', '=', 'assignment.org_id')
              .onRef('team.id', '=', 'assignment.team_season_id'),
          )
          .select(['assignment.id', 'assignment.role', 'team.program_id'])
          .where('assignment.org_id', '=', context.orgId)
          .where('assignment.person_id', '=', row.person_id)
          .where('assignment.status', '=', 'active')
          .execute();
        for (const assignment of staff) {
          const result = await evaluateRoleEligibility(
            trx,
            context,
            {
              personId: row.person_id,
              role: assignment.role as ComplianceRole,
              ...(assignment.program_id
                ? { programId: assignment.program_id }
                : {}),
            },
            now,
          );
          if (!result.eligible) {
            await trx
              .updateTable('team_staff')
              .set({
                status: 'pending_compliance',
                version: sql<number>`version + 1`,
              })
              .where('org_id', '=', context.orgId)
              .where('id', '=', assignment.id)
              .where('status', '=', 'active')
              .execute();
            await notifyCredentialStatus(
              trx,
              context,
              row.person_id,
              row.id,
              'compliance.role_demoted',
              { role: assignment.role, assignmentId: assignment.id },
            );
            demoted += 1;
          }
        }
        expired += 1;
      } else if (row.renewal_reminder_days.includes(daysBefore)) {
        const inserted = await trx
          .insertInto('credential_reminder_events')
          .values({
            id: newId(),
            org_id: context.orgId,
            person_credential_id: row.id,
            expires_on: expiresOn,
            days_before: daysBefore,
          })
          .onConflict((oc) =>
            oc
              .columns([
                'org_id',
                'person_credential_id',
                'expires_on',
                'days_before',
              ])
              .doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (!inserted) continue;
        await notifyCredentialStatus(
          trx,
          context,
          row.person_id,
          row.id,
          'compliance.credential_expiry_reminder',
          { daysBefore, expiresOn },
        );
        reminded += 1;
      }
    }
    return { reminded, expired, demoted };
  });
}

export async function saveCheckrResult(
  dependencies: ComplianceDependencies,
  context: OrgContext,
  input: {
    providerEventId: string;
    reportId: string;
    status:
      'pending' | 'clear' | 'consider' | 'suspended' | 'canceled' | 'expired';
    completedAt?: string;
  },
): Promise<boolean> {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const order = await trx
      .selectFrom('background_check_orders')
      .select(['id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('provider', '=', 'checkr')
      .where('provider_report_id', '=', input.reportId)
      .executeTakeFirst();
    if (!order) return false;
    const event = await trx
      .insertInto('background_check_webhook_events')
      .values({
        id: newId(),
        org_id: context.orgId,
        provider_event_id: input.providerEventId,
        report_id: input.reportId,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'provider_event_id']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!event) return true;
    const resultSummary =
      input.status === 'clear'
        ? 'clear'
        : input.status === 'consider'
          ? 'consider'
          : null;
    const details = JSON.stringify({
      providerReportId: input.reportId,
      status: input.status,
    });
    await trx
      .updateTable('background_check_orders')
      .set({
        status: input.status,
        result_summary: resultSummary,
        completed_at: input.completedAt
          ? new Date(input.completedAt)
          : ['clear', 'consider', 'canceled', 'expired'].includes(input.status)
            ? dependencies.clock()
            : null,
        details_enc: encryptRestricted(
          Buffer.from(details),
          dependencies.encryption,
        ),
        version: sql<number>`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', order.id)
      .where('version', '=', order.version)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: null,
        action: 'background_check.provider_result.received',
        entity_type: 'background_check_order',
        entity_id: order.id,
        changes: { provider: 'checkr', status: input.status },
      })
      .execute();
    const officers = await trx
      .selectFrom('role_assignments')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('role', 'in', ['owner', 'compliance'])
      .where('scope_type', '=', 'org')
      .where('revoked_at', 'is', null)
      .where('pending_mfa', '=', false)
      .execute();
    await notifyAccounts(
      trx,
      context,
      officers.map((officer) => officer.account_id),
      'compliance.background_check_result',
      {
        orderId: order.id,
        status: input.status,
      },
    );
    return true;
  });
}
