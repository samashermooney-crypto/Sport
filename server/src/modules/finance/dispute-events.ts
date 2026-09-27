import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type {
  GatewayDispute,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import type {
  DisputeLiabilityRepository,
  LiabilityMovement,
} from './dispute-liability-repo.js';

export interface DisputeSnapshotRepository {
  applyLatest(
    orgId: string,
    latest: GatewayDispute,
  ): Promise<'applied' | 'unchanged'>;
}

const disputeObject = z.object({
  id: z.string().startsWith('dp_'),
  object: z.literal('dispute'),
});

/** Applies latest Stripe dispute state, then fences every external money movement. */
export class DisputeEventService {
  constructor(
    private readonly gateway: Pick<
      PaymentsGateway,
      | 'retrieveDispute'
      | 'retrieveTransfer'
      | 'reverseTransfer'
      | 'createTransfer'
    >,
    private readonly snapshots: DisputeSnapshotRepository,
    private readonly liability: DisputeLiabilityRepository,
  ) {}

  async handle(orgId: string, disputeId: string): Promise<void> {
    const latest = await this.gateway.retrieveDispute(disputeId);
    if (latest.id !== disputeId)
      throw new Error('Stripe returned a different dispute');
    await this.handleLatest(orgId, latest);
  }

  async handleLatest(orgId: string, latest: GatewayDispute): Promise<void> {
    if (
      !Number.isSafeInteger(latest.reinstatedNetCents) ||
      latest.reinstatedNetCents < 0
    )
      throw new Error('Invalid Stripe dispute reinstatement cents');
    await this.snapshots.applyLatest(orgId, latest);
    const accountId = await this.liability.connectedAccount(orgId);
    let reversal = await this.liability.load(
      orgId,
      latest.id,
      'from_connected',
    );
    const resolvedWon =
      latest.status === 'won' || latest.status === 'prevented';
    if (!reversal && latest.fundsWithdrawn && !resolvedWon) {
      if (!latest.transferId)
        throw new Error('Disputed charge has no transfer');
      const transfer = await this.gateway.retrieveTransfer(latest.transferId);
      if (
        transfer.id !== latest.transferId ||
        transfer.destinationAccountId !== accountId
      )
        throw new Error('Stripe dispute transfer account mismatch');
      const remaining = transfer.amountCents - transfer.amountReversedCents;
      if (!Number.isSafeInteger(remaining) || remaining < 0)
        throw new Error('Invalid Stripe transfer reversal balance');
      const desired = latest.amountCents + latest.feeCents;
      if (!Number.isSafeInteger(desired))
        throw new Error('Dispute liability exceeds safe cents');
      const amountCents = Math.min(desired, remaining);
      reversal = await this.liability.claim({
        orgId,
        disputeId: latest.id,
        direction: 'from_connected',
        transferId: latest.transferId,
        amountCents,
        unrecoveredCents: desired - amountCents,
      });
    }
    if (reversal && reversal.amountCents > 0)
      await this.executeReversal(orgId, latest, reversal);
    if (
      resolvedWon &&
      reversal?.state === 'completed' &&
      reversal.amountCents > 0
    ) {
      if (!latest.fundsReinstated || latest.reinstatedNetCents < 1)
        throw new Error('Won dispute funds have not been reinstated');
      if (!latest.transferId)
        throw new Error('Disputed charge has no transfer');
      const amountCents = Math.min(
        reversal.amountCents,
        latest.reinstatedNetCents,
      );
      const existing = await this.liability.load(
        orgId,
        latest.id,
        'to_connected',
      );
      const restoration =
        existing ??
        (await this.liability.claim({
          orgId,
          disputeId: latest.id,
          direction: 'to_connected',
          transferId: latest.transferId,
          amountCents,
          unrecoveredCents: reversal.amountCents - amountCents,
        }));
      await this.executeRestoration(orgId, accountId, latest, restoration);
    }
  }

  private async executeReversal(
    orgId: string,
    latest: GatewayDispute,
    movement: LiabilityMovement,
  ): Promise<void> {
    if (movement.state === 'completed') return;
    if (
      movement.state !== 'reserved' ||
      !(await this.liability.start(orgId, movement.id))
    )
      throw new Error(
        'Dispute reversal already started; reconcile Stripe before retry',
      );
    if (!latest.transferId) throw new Error('Disputed charge has no transfer');
    const result = await this.gateway.reverseTransfer({
      transferId: latest.transferId,
      amountCents: movement.amountCents,
      idempotencyKey: movement.idempotencyKey,
    });
    if (result.amountCents !== movement.amountCents)
      throw new Error('Stripe reversed a different dispute amount');
    await this.liability.complete({
      orgId,
      movementId: movement.id,
      stripeMovementId: result.id,
      amountCents: result.amountCents,
    });
    movement.state = 'completed';
  }

  private async executeRestoration(
    orgId: string,
    accountId: string,
    latest: GatewayDispute,
    movement: LiabilityMovement,
  ): Promise<void> {
    if (movement.state === 'completed') return;
    if (
      movement.state !== 'reserved' ||
      !(await this.liability.start(orgId, movement.id))
    )
      throw new Error(
        'Dispute restoration already started; reconcile Stripe before retry',
      );
    const result = await this.gateway.createTransfer({
      destinationAccountId: accountId,
      amountCents: movement.amountCents,
      disputeId: latest.id,
      idempotencyKey: movement.idempotencyKey,
    });
    if (result.amountCents !== movement.amountCents)
      throw new Error('Stripe restored a different dispute amount');
    await this.liability.complete({
      orgId,
      movementId: movement.id,
      stripeMovementId: result.id,
      amountCents: result.amountCents,
    });
  }
}

export function disputeHandlers(
  service: DisputeEventService,
  gateway: Pick<PaymentsGateway, 'retrieveDispute' | 'retrieveTransfer'>,
  resolveOrg: (stripeAccountId: string) => Promise<string>,
): StripeEventHandlers {
  const handle = async (event: StripeWebhookEvent): Promise<void> => {
    if (event.account)
      throw new Error('Destination dispute must arrive on platform endpoint');
    const object = disputeObject.parse(event.data.object);
    const latest = await gateway.retrieveDispute(object.id);
    if (!latest.transferId) throw new Error('Disputed charge has no transfer');
    const transfer = await gateway.retrieveTransfer(latest.transferId);
    const orgId = await resolveOrg(transfer.destinationAccountId);
    await service.handleLatest(orgId, latest);
  };
  return {
    'charge.dispute.created': handle,
    'charge.dispute.updated': handle,
    'charge.dispute.closed': handle,
    'charge.dispute.funds_withdrawn': handle,
    'charge.dispute.funds_reinstated': handle,
  };
}
