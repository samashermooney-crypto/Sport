import { Temporal } from '@js-temporal/polyfill';
import { orgToday } from '@shared/dates';
import { sql, type Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';
import { systemWorkerActorId } from '../jobs/credentials-expiry';
import { isNotificationType } from '../notifications/catalog';
import { createNotification } from '../notifications/service';

import type { sponsorBodySchema, sponsorPatchSchema } from './schema';

class SponsorConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}
export class SponsorNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}

type SponsorBody = z.output<typeof sponsorBodySchema>;
type SponsorPatch = z.output<typeof sponsorPatchSchema>;

const RENEWAL_WINDOW_DAYS = 30;

async function validatePlacementTargets(
  trx: OrgTransaction,
  context: OrgContext,
  placements: SponsorBody['placements'],
) {
  for (const placement of placements) {
    if (placement.surface === 'program_page' && placement.programId) {
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', placement.programId)
        .executeTakeFirst();
      if (!program)
        throw new SponsorNotFoundError('Placement program not found');
    }
    if (placement.surface === 'team_page' && placement.teamSeasonId) {
      const team = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', placement.teamSeasonId)
        .executeTakeFirst();
      if (!team) throw new SponsorNotFoundError('Placement team not found');
    }
  }
}

export async function createSponsor(
  database: Kysely<DB>,
  context: OrgContext,
  input: SponsorBody,
) {
  return createWithOrg(database)(context, async (trx) => {
    await validatePlacementTargets(trx, context, input.placements);
    const result = await trx
      .insertInto('sponsors')
      .values({
        org_id: context.orgId,
        name: input.name,
        contact: JSON.stringify(input.contact),
        logo_file_id: input.logoFileId ?? null,
        website_url: input.websiteUrl ?? null,
        tier: input.tier,
        amount_cents: input.amountCents,
        contract_start: input.contractStart,
        contract_end: input.contractEnd,
        placements: JSON.stringify(input.placements),
        status: input.status,
        created_by: context.actor.accountId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'sponsor.created',
      entityType: 'sponsor',
      entityId: result.id,
      changes: {
        name: { tier: 'internal', after: input.name },
        amountCents: { tier: 'internal', after: input.amountCents },
      },
    });
    return result.id;
  });
}

interface SponsorRow {
  id: string;
  name: string;
  contact: unknown;
  logo_file_id: string | null;
  website_url: string | null;
  tier: string;
  amount_cents: number;
  contract_start: Date | string;
  contract_end: Date | string;
  placements: unknown;
  invoice_id: string | null;
  status: 'prospect' | 'active' | 'expired' | 'archived';
  renewal_notified_at: Date | null;
  version: number;
  invoice_status: string | null;
  invoice_balance_cents: number | null;
}

const dateOnly = (value: Date | string): string =>
  typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);

function sponsorView(row: SponsorRow) {
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    logoFileId: row.logo_file_id,
    websiteUrl: row.website_url,
    tier: row.tier,
    amountCents: row.amount_cents,
    contractStart: dateOnly(row.contract_start),
    contractEnd: dateOnly(row.contract_end),
    placements: row.placements,
    invoiceId: row.invoice_id,
    invoiceStatus: row.invoice_status,
    invoiceBalanceCents: row.invoice_balance_cents,
    status: row.status,
    renewalNotifiedAt: row.renewal_notified_at?.toISOString() ?? null,
    version: row.version,
  };
}

const sponsorSelect = sql<SponsorRow>`
  SELECT sponsor.id, sponsor.name, sponsor.contact, sponsor.logo_file_id,
    sponsor.website_url, sponsor.tier, sponsor.amount_cents,
    sponsor.contract_start, sponsor.contract_end, sponsor.placements,
    sponsor.invoice_id, sponsor.status, sponsor.renewal_notified_at,
    sponsor.version,
    invoice.status AS invoice_status, invoice.balance_cents AS invoice_balance_cents
  FROM sponsors sponsor
  LEFT JOIN invoices invoice
    ON invoice.org_id = sponsor.org_id AND invoice.id = sponsor.invoice_id
`;

export async function listSponsors(database: Kysely<DB>, context: OrgContext) {
  const result = await createWithOrg(database)(context, (trx) =>
    sql<SponsorRow>`
      ${sponsorSelect}
      WHERE sponsor.org_id = ${context.orgId}::uuid
      ORDER BY sponsor.contract_end, sponsor.name
    `.execute(trx),
  );
  return result.rows.map(sponsorView);
}

export async function getSponsor(
  database: Kysely<DB>,
  context: OrgContext,
  sponsorId: string,
) {
  const result = await createWithOrg(database)(context, (trx) =>
    sql<SponsorRow>`
      ${sponsorSelect}
      WHERE sponsor.org_id = ${context.orgId}::uuid
        AND sponsor.id = ${sponsorId}::uuid
    `.execute(trx),
  );
  const row = result.rows[0];
  if (!row) throw new SponsorNotFoundError('Sponsor not found');
  return sponsorView(row);
}

export async function updateSponsor(
  database: Kysely<DB>,
  context: OrgContext,
  sponsorId: string,
  input: SponsorPatch,
) {
  await createWithOrg(database)(context, async (trx) => {
    const current = await trx
      .selectFrom('sponsors')
      .select(['version', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', sponsorId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new SponsorNotFoundError('Sponsor not found');
    if (current.version !== input.expectedVersion)
      throw new SponsorConflictError('Sponsor changed');
    if (current.status === 'archived')
      throw new SponsorConflictError('Archived sponsors cannot be edited');
    if (input.placements)
      await validatePlacementTargets(trx, context, input.placements);
    const start = input.contractStart;
    const end = input.contractEnd;
    if (start && end && start > end)
      throw new SponsorConflictError('Contract start must be on or before end');
    await trx
      .updateTable('sponsors')
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.contact !== undefined
          ? { contact: JSON.stringify(input.contact) }
          : {}),
        ...(input.logoFileId !== undefined
          ? { logo_file_id: input.logoFileId }
          : {}),
        ...(input.websiteUrl !== undefined
          ? { website_url: input.websiteUrl }
          : {}),
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
        ...(input.amountCents !== undefined
          ? { amount_cents: input.amountCents }
          : {}),
        ...(start ? { contract_start: start } : {}),
        ...(end ? { contract_end: end } : {}),
        ...(input.placements
          ? { placements: JSON.stringify(input.placements) }
          : {}),
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', sponsorId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'sponsor.updated',
      entityType: 'sponsor',
      entityId: sponsorId,
      changes: {},
    });
  });
  return getSponsor(database, context, sponsorId);
}

const transitions: Record<string, readonly string[]> = {
  prospect: ['active', 'archived'],
  active: ['expired', 'archived'],
  expired: ['archived', 'active'],
  archived: [],
};

export async function setSponsorStatus(
  database: Kysely<DB>,
  context: OrgContext,
  sponsorId: string,
  input: { status: string; expectedVersion: number },
) {
  await createWithOrg(database)(context, async (trx) => {
    const current = await trx
      .selectFrom('sponsors')
      .select(['version', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', sponsorId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new SponsorNotFoundError('Sponsor not found');
    if (current.version !== input.expectedVersion)
      throw new SponsorConflictError('Sponsor changed');
    if (!(transitions[current.status] ?? []).includes(input.status))
      throw new SponsorConflictError(
        `Sponsor cannot move from ${current.status} to ${input.status}`,
      );
    await trx
      .updateTable('sponsors')
      .set({
        status: input.status,
        renewal_notified_at: null,
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', sponsorId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'sponsor.status_changed',
      entityType: 'sponsor',
      entityId: sponsorId,
      changes: {
        status: {
          tier: 'internal',
          before: current.status,
          after: input.status,
        },
      },
    });
  });
  return getSponsor(database, context, sponsorId);
}

export async function issueSponsorInvoice(
  database: Kysely<DB>,
  context: OrgContext,
  sponsorId: string,
  input: {
    accountId?: string | undefined;
    amountCents?: number | undefined;
    dueOn?: string | undefined;
    memo?: string | undefined;
    creationKey: string;
  },
) {
  const sponsor = await createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .selectFrom('sponsors')
      .select(['id', 'name', 'tier', 'amount_cents', 'status', 'contact'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', sponsorId)
      .executeTakeFirst();
    if (!row) throw new SponsorNotFoundError('Sponsor not found');
    if (row.status === 'archived')
      throw new SponsorConflictError('Archived sponsors cannot be invoiced');
    return row;
  });
  const contact = sponsor.contact as { accountId?: string | null };
  const accountId = input.accountId ?? contact.accountId ?? undefined;
  if (!accountId)
    throw new SponsorConflictError(
      'A billing account is required to invoice a sponsor',
    );
  const member = await createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', accountId)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  );
  if (!member)
    throw new SponsorConflictError(
      'Billing account is not an active organization member',
    );
  const amountCents = input.amountCents ?? sponsor.amount_cents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    throw new RangeError(
      'Sponsor invoice amount is outside the supported range',
    );
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId: context.orgId,
    accountId,
    source: 'staff',
    ...(input.dueOn ? { dueOn: input.dueOn } : {}),
    creationKey: input.creationKey,
    memo: input.memo ?? `Sponsorship — ${sponsor.name} (${sponsor.tier})`,
    lines: [
      {
        kind: 'adjustment',
        description: `Sponsorship — ${sponsor.name} (${sponsor.tier})`,
        amountCents,
        refundable: false,
      },
    ],
  });
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .updateTable('sponsors')
      .set({
        invoice_id: invoice.id,
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', sponsorId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'sponsor.invoice_issued',
      entityType: 'sponsor',
      entityId: sponsorId,
      changes: {
        invoiceId: { tier: 'internal', after: invoice.id },
        amountCents: { tier: 'internal', after: invoice.totalCents },
      },
    });
  });
  return { invoiceId: invoice.id, totalCents: invoice.totalCents };
}

export async function publicSponsorPlacements(
  database: Kysely<DB>,
  orgSlug: string,
  surface: 'website_home' | 'program_page' | 'team_page' | 'email_footer',
  targetId?: string,
  now = new Date(),
) {
  const organization = await database
    .selectFrom('organizations')
    .select(['id', 'status', 'timezone'])
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!organization || organization.status !== 'active')
    throw new SponsorNotFoundError('Organization not found');
  const context: OrgContext = {
    orgId: organization.id,
    actor: { accountId: systemWorkerActorId },
  };
  const today = orgToday(
    organization.timezone,
    Temporal.Instant.fromEpochMilliseconds(now.getTime()),
  );
  return createWithOrg(database)(context, async (trx) => {
    const rows = await sql<{
      id: string;
      name: string;
      tier: string;
      website_url: string | null;
      logo_file_id: string | null;
    }>`
      SELECT id, name, tier, website_url, logo_file_id FROM sponsors
      WHERE org_id = ${context.orgId}::uuid
        AND status = 'active'
        AND contract_start <= ${today}::date
        AND contract_end >= ${today}::date
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(placements) placement
          WHERE placement->>'surface' = ${surface}
            AND (
              ${targetId ?? null}::uuid IS NULL
              OR placement->>'programId' = ${targetId ?? ''}
              OR placement->>'teamSeasonId' = ${targetId ?? ''}
            )
        )
      ORDER BY tier, name
    `.execute(trx);
    return rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      tier: row.tier,
      websiteUrl: row.website_url,
      logoFileId: row.logo_file_id,
    }));
  });
}

export async function runSponsorRenewalJob(
  database: Kysely<DB>,
  now = new Date(),
): Promise<{ notified: number }> {
  const renewalType: string = 'sponsor.renewal_reminder';
  if (!isNotificationType(renewalType)) return { notified: 0 };
  const organizations = await database
    .selectFrom('organizations')
    .select(['id', 'timezone'])
    .where('status', '=', 'active')
    .execute();
  let notified = 0;
  for (const organization of organizations) {
    const context: OrgContext = {
      orgId: organization.id,
      actor: { accountId: systemWorkerActorId },
    };
    const today = orgToday(
      organization.timezone,
      Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    );
    const windowEnd = Temporal.PlainDate.from(today)
      .add({ days: RENEWAL_WINDOW_DAYS })
      .toString();
    notified += await createWithOrg(database)(context, async (trx) => {
      const expiring = await trx
        .selectFrom('sponsors')
        .select(['id', 'name', 'contract_end'])
        .where('org_id', '=', context.orgId)
        .where('status', '=', 'active')
        .where('contract_end', '<=', sql<Date>`${windowEnd}::date`)
        .where('contract_end', '>=', sql<Date>`${today}::date`)
        .where('renewal_notified_at', 'is', null)
        .execute();
      if (!expiring.length) return 0;
      const staff = await trx
        .selectFrom('role_assignments')
        .select('account_id')
        .where('org_id', '=', context.orgId)
        .where('role', 'in', ['owner', 'admin', 'finance'])
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .where('pending_mfa', '=', false)
        .execute();
      for (const sponsor of expiring) {
        for (const recipient of staff) {
          await createNotification(trx, context, {
            accountId: recipient.account_id,
            type: renewalType,
            payload: {
              resourceType: 'sponsor',
              resourceId: sponsor.id,
              expiresOn: dateOnly(sponsor.contract_end),
              href: `/console/orgs/${context.orgId}/sponsors`,
            },
          });
        }
        await trx
          .updateTable('sponsors')
          .set({ renewal_notified_at: now })
          .where('org_id', '=', context.orgId)
          .where('id', '=', sponsor.id)
          .execute();
      }
      return expiring.length;
    });
  }
  return { notified };
}
