import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB, Json } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import {
  type ConnectAccount,
  type ConnectAccountRepository,
  type ConnectReservation,
} from './connect.js';

function requirements(account: ConnectAccount): Json {
  return {
    currentlyDue: [...account.requirementsDue].sort(),
    disabledReason: account.disabledReason,
  };
}

function status(account: ConnectAccount): string {
  if (account.chargesEnabled && account.payoutsEnabled) return 'active';
  if (account.disabledReason) return 'disabled';
  if (account.detailsSubmitted) return 'restricted';
  return 'pending';
}

function accountFrom(row: {
  org_id: string;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements: Json;
}): ConnectAccount | null {
  if (!row.stripe_account_id) return null;
  const raw = row.requirements;
  const due =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.currentlyDue
      : null;
  const reason =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.disabledReason
      : null;
  return {
    orgId: row.org_id,
    stripeAccountId: row.stripe_account_id,
    chargesEnabled: row.charges_enabled,
    payoutsEnabled: row.payouts_enabled,
    detailsSubmitted: row.details_submitted,
    requirementsDue: Array.isArray(due)
      ? due.filter((value): value is string => typeof value === 'string')
      : [],
    disabledReason: typeof reason === 'string' ? reason : null,
  };
}

/** Bound to one org and actor; every payment_accounts query uses withOrg. */
export class PostgresConnectAccountRepository implements ConnectAccountRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId) {
      throw new Error('Connect repository organization mismatch');
    }
  }

  async reserve(orgId: string): Promise<ConnectReservation> {
    this.assertOrg(orgId);
    return this.withOrg(this.context, async (trx) => {
      const inserted = await trx
        .insertInto('payment_accounts')
        .values({
          id: newId(),
          org_id: orgId,
          stripe_account_id: null,
          statement_descriptor: null,
          requirements: {},
        })
        .onConflict((conflict) => conflict.column('org_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted) return { kind: 'reserved' };
      const row = await trx
        .selectFrom('payment_accounts')
        .selectAll()
        .where('org_id', '=', orgId)
        .executeTakeFirstOrThrow();
      const account = accountFrom(row);
      return account ? { kind: 'existing', account } : { kind: 'busy' };
    });
  }

  async saveCreated(account: ConnectAccount): Promise<void> {
    this.assertOrg(account.orgId);
    await this.withOrg(this.context, async (trx) => {
      const updated = await trx
        .updateTable('payment_accounts')
        .set({
          stripe_account_id: account.stripeAccountId,
          charges_enabled: account.chargesEnabled,
          payouts_enabled: account.payoutsEnabled,
          details_submitted: account.detailsSubmitted,
          requirements: requirements(account),
          onboarding_status: status(account),
          version: sql`version + 1`,
        })
        .where('org_id', '=', account.orgId)
        .where('stripe_account_id', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!updated)
        throw new Error('Connect reservation is missing or completed');
    });
  }

  async load(orgId: string): Promise<ConnectAccount | null> {
    this.assertOrg(orgId);
    return this.withOrg(this.context, async (trx) => {
      const row = await trx
        .selectFrom('payment_accounts')
        .selectAll()
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      return row ? accountFrom(row) : null;
    });
  }

  async update(account: ConnectAccount): Promise<void> {
    this.assertOrg(account.orgId);
    await this.withOrg(this.context, async (trx) => {
      const before = await trx
        .selectFrom('payment_accounts')
        .selectAll()
        .where('org_id', '=', account.orgId)
        .where('stripe_account_id', '=', account.stripeAccountId)
        .forUpdate()
        .executeTakeFirst();
      if (!before)
        throw new Error(
          'Connected account does not belong to this organization',
        );
      const current = accountFrom(before);
      if (
        current &&
        current.chargesEnabled === account.chargesEnabled &&
        current.payoutsEnabled === account.payoutsEnabled &&
        current.detailsSubmitted === account.detailsSubmitted &&
        current.disabledReason === account.disabledReason &&
        JSON.stringify([...current.requirementsDue].sort()) ===
          JSON.stringify([...account.requirementsDue].sort())
      )
        return;
      const updated = await trx
        .updateTable('payment_accounts')
        .set({
          charges_enabled: account.chargesEnabled,
          payouts_enabled: account.payoutsEnabled,
          details_submitted: account.detailsSubmitted,
          requirements: requirements(account),
          onboarding_status: status(account),
          version: sql`version + 1`,
        })
        .where('org_id', '=', account.orgId)
        .where('stripe_account_id', '=', account.stripeAccountId)
        .returning('id')
        .executeTakeFirst();
      if (!updated)
        throw new Error(
          'Connected account does not belong to this organization',
        );
      await appendAuditEvent(trx, this.context, {
        action: 'connect.account_synced',
        entityType: 'payment_account',
        entityId: updated.id,
        changes: {
          chargesEnabled: {
            tier: 'internal',
            before: current?.chargesEnabled,
            after: account.chargesEnabled,
          },
          payoutsEnabled: {
            tier: 'internal',
            before: current?.payoutsEnabled,
            after: account.payoutsEnabled,
          },
          disabledReason: {
            tier: 'internal',
            before: current?.disabledReason,
            after: account.disabledReason,
          },
        },
      });
    });
  }
}
