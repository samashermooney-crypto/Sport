import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

export type MovementDirection = 'from_connected' | 'to_connected';
export interface LiabilityMovement {
  id: string;
  amountCents: number;
  unrecoveredCents: number;
  state: 'reserved' | 'external_started' | 'completed' | 'failed';
  idempotencyKey: string;
  stripeMovementId: string | null;
}

export interface DisputeLiabilityRepository {
  connectedAccount(orgId: string): Promise<string>;
  claim(input: {
    orgId: string;
    disputeId: string;
    direction: MovementDirection;
    transferId: string;
    amountCents: number;
    unrecoveredCents: number;
  }): Promise<LiabilityMovement>;
  start(orgId: string, movementId: string): Promise<boolean>;
  complete(input: {
    orgId: string;
    movementId: string;
    stripeMovementId: string;
    amountCents: number;
  }): Promise<void>;
  load(
    orgId: string,
    disputeId: string,
    direction: MovementDirection,
  ): Promise<LiabilityMovement | null>;
}

interface MovementRow {
  id: string;
  amount_cents: number;
  unrecovered_cents: number;
  state: LiabilityMovement['state'];
  idempotency_key: string;
  stripe_movement_id: string | null;
  stripe_transfer_id: string;
}

function view(row: MovementRow): LiabilityMovement {
  return {
    id: row.id,
    amountCents: row.amount_cents,
    unrecoveredCents: row.unrecovered_cents,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    stripeMovementId: row.stripe_movement_id,
  };
}

/** Durable claims fence all outbound Stripe dispute movements. */
export class PostgresDisputeLiabilityRepository implements DisputeLiabilityRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
  ) {
    this.withOrg = createWithOrg(database);
  }

  private context(orgId: string): OrgContext {
    return { orgId, actor: { accountId: this.actorAccountId } };
  }

  async connectedAccount(orgId: string): Promise<string> {
    return this.withOrg(this.context(orgId), async (trx) => {
      const row = await trx
        .selectFrom('payment_accounts')
        .select('stripe_account_id')
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!row?.stripe_account_id)
        throw new Error('Organization has no connected Stripe account');
      return row.stripe_account_id;
    });
  }

  async load(
    orgId: string,
    disputeId: string,
    direction: MovementDirection,
  ): Promise<LiabilityMovement | null> {
    return this.withOrg(this.context(orgId), async (trx) => {
      const result = await sql<MovementRow>`
        SELECT id, amount_cents, unrecovered_cents, state,
          idempotency_key, stripe_movement_id, stripe_transfer_id
        FROM dispute_liability_movements
        WHERE org_id = ${orgId}::uuid AND dispute_id = (
          SELECT id FROM disputes WHERE org_id = ${orgId}::uuid
            AND stripe_dispute_id = ${disputeId})
          AND direction = ${direction}
      `.execute(trx);
      return result.rows[0] ? view(result.rows[0]) : null;
    });
  }

  async claim(
    input: Parameters<DisputeLiabilityRepository['claim']>[0],
  ): Promise<LiabilityMovement> {
    if (
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents < 0 ||
      !Number.isSafeInteger(input.unrecoveredCents) ||
      input.unrecoveredCents < 0 ||
      input.amountCents + input.unrecoveredCents < 1
    )
      throw new Error('Invalid dispute liability cents');
    return this.withOrg(this.context(input.orgId), async (trx) => {
      const dispute = await sql<{
        id: string;
        stripe_transfer_id: string | null;
      }>`
        SELECT id, stripe_transfer_id FROM disputes
        WHERE org_id = ${input.orgId}::uuid
          AND stripe_dispute_id = ${input.disputeId} FOR UPDATE
      `.execute(trx);
      const record = dispute.rows[0];
      if (!record || record.stripe_transfer_id !== input.transferId)
        throw new Error('Dispute transfer does not belong to organization');
      const idempotencyKey = `dispute:${input.disputeId}:${input.direction}`;
      await sql`
        INSERT INTO dispute_liability_movements (
          id, org_id, dispute_id, direction, amount_cents,
          unrecovered_cents, stripe_transfer_id, state, idempotency_key)
        VALUES (${newId()}::uuid, ${input.orgId}::uuid,
          ${record.id}::uuid, ${input.direction}, ${input.amountCents},
          ${input.unrecoveredCents}, ${input.transferId},
          ${input.amountCents === 0 ? 'completed' : 'reserved'},
          ${idempotencyKey})
        ON CONFLICT (org_id, dispute_id, direction) DO NOTHING
      `.execute(trx);
      const result = await sql<MovementRow>`
        SELECT id, amount_cents, unrecovered_cents, state,
          idempotency_key, stripe_movement_id, stripe_transfer_id
        FROM dispute_liability_movements
        WHERE org_id = ${input.orgId}::uuid AND dispute_id = ${record.id}::uuid
          AND direction = ${input.direction} FOR UPDATE
      `.execute(trx);
      const movement = result.rows[0];
      if (
        !movement ||
        movement.amount_cents !== input.amountCents ||
        movement.unrecovered_cents !== input.unrecoveredCents ||
        movement.stripe_transfer_id !== input.transferId
      )
        throw new Error('Dispute liability claim conflicts with prior cents');
      return view(movement);
    });
  }

  async start(orgId: string, movementId: string): Promise<boolean> {
    return this.withOrg(this.context(orgId), async (trx) => {
      const result = await sql<{ id: string }>`
        UPDATE dispute_liability_movements
        SET state = 'external_started', version = version + 1
        WHERE org_id = ${orgId}::uuid AND id = ${movementId}::uuid
          AND state = 'reserved' RETURNING id
      `.execute(trx);
      return result.rows.length === 1;
    });
  }

  async complete(
    input: Parameters<DisputeLiabilityRepository['complete']>[0],
  ): Promise<void> {
    await this.withOrg(this.context(input.orgId), async (trx) => {
      const result = await sql<{ id: string }>`
        UPDATE dispute_liability_movements
        SET state = 'completed', stripe_movement_id = ${input.stripeMovementId},
          version = version + 1
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.movementId}::uuid
          AND amount_cents = ${input.amountCents}
          AND state = 'external_started' RETURNING id
      `.execute(trx);
      if (result.rows.length !== 1)
        throw new Error('Dispute movement completion conflicts with claim');
    });
  }
}
