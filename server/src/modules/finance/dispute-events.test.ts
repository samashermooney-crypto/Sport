import { describe, expect, it, vi } from 'vitest';

import type { GatewayDispute } from '../../integrations/stripe/gateway.js';

import { DisputeEventService } from './dispute-events.js';
import type {
  DisputeLiabilityRepository,
  LiabilityMovement,
  MovementDirection,
} from './dispute-liability-repo.js';

const active: GatewayDispute = {
  id: 'dp_test',
  chargeId: 'ch_test',
  paymentIntentId: 'pi_test',
  transferId: 'tr_test',
  status: 'needs_response',
  amountCents: 400,
  feeCents: 1500,
  reason: 'general',
  evidenceDueBy: null,
  fundsWithdrawn: true,
  fundsReinstated: false,
  reinstatedNetCents: 0,
};

describe('dispute liability orchestration', () => {
  it('caps reversal at unreversed transfer cents, records shortfall, then restores only reinstated funds', async () => {
    const movements = new Map<MovementDirection, LiabilityMovement>();
    const liability: DisputeLiabilityRepository = {
      connectedAccount: vi.fn().mockResolvedValue('acct_org'),
      load: vi.fn((_orgId, _disputeId, direction: MovementDirection) =>
        Promise.resolve(movements.get(direction) ?? null),
      ),
      claim: vi.fn(
        (input: Parameters<DisputeLiabilityRepository['claim']>[0]) => {
          const movement: LiabilityMovement = {
            id: input.direction,
            amountCents: input.amountCents,
            unrecoveredCents: input.unrecoveredCents,
            state: input.amountCents === 0 ? 'completed' : 'reserved',
            idempotencyKey: `dispute:${input.disputeId}:${input.direction}`,
            stripeMovementId: null,
          };
          movements.set(input.direction, movement);
          return Promise.resolve(movement);
        },
      ),
      start: vi.fn((_orgId: string, movementId: string) => {
        const movement = movements.get(movementId as MovementDirection);
        if (movement?.state !== 'reserved') return Promise.resolve(false);
        movement.state = 'external_started';
        return Promise.resolve(true);
      }),
      complete: vi.fn(
        (input: Parameters<DisputeLiabilityRepository['complete']>[0]) => {
          const movement = movements.get(input.movementId as MovementDirection);
          if (!movement) throw new Error('Missing movement');
          movement.state = 'completed';
          movement.stripeMovementId = input.stripeMovementId;
          return Promise.resolve();
        },
      ),
    };
    const gateway = {
      retrieveDispute: vi.fn().mockResolvedValue(active),
      retrieveTransfer: vi.fn().mockResolvedValue({
        id: 'tr_test',
        amountCents: 1000,
        amountReversedCents: 0,
        destinationAccountId: 'acct_org',
      }),
      reverseTransfer: vi
        .fn()
        .mockResolvedValue({ id: 'trr_test', amountCents: 1000 }),
      createTransfer: vi
        .fn()
        .mockResolvedValue({ id: 'tr_restore', amountCents: 400 }),
    };
    const snapshots = {
      applyLatest: vi.fn().mockResolvedValue('applied' as const),
    };
    const service = new DisputeEventService(gateway, snapshots, liability);
    await service.handleLatest('org-one', active);
    expect(gateway.reverseTransfer).toHaveBeenCalledWith({
      transferId: 'tr_test',
      amountCents: 1000,
      idempotencyKey: 'dispute:dp_test:from_connected',
    });
    expect(movements.get('from_connected')).toMatchObject({
      state: 'completed',
      amountCents: 1000,
      unrecoveredCents: 900,
    });
    await service.handleLatest('org-one', active);
    expect(gateway.reverseTransfer).toHaveBeenCalledTimes(1);
    await service.handleLatest('org-one', {
      ...active,
      status: 'won',
      fundsReinstated: true,
      reinstatedNetCents: 400,
    });
    expect(gateway.createTransfer).toHaveBeenCalledWith({
      destinationAccountId: 'acct_org',
      amountCents: 400,
      disputeId: 'dp_test',
      idempotencyKey: 'dispute:dp_test:to_connected',
    });
    expect(movements.get('to_connected')).toMatchObject({
      state: 'completed',
      amountCents: 400,
      unrecoveredCents: 600,
    });
  });

  it('leaves an ambiguous external start fenced from duplicate Stripe calls', async () => {
    const liability = {
      connectedAccount: vi.fn().mockResolvedValue('acct_org'),
      load: vi.fn().mockResolvedValue({
        id: 'movement',
        amountCents: 400,
        unrecoveredCents: 0,
        state: 'external_started',
        idempotencyKey: 'dispute:dp_test:from_connected',
        stripeMovementId: null,
      }),
      claim: vi.fn(),
      start: vi.fn(),
      complete: vi.fn(),
    };
    const gateway = {
      retrieveDispute: vi.fn(),
      retrieveTransfer: vi.fn(),
      reverseTransfer: vi.fn(),
      createTransfer: vi.fn(),
    };
    const service = new DisputeEventService(
      gateway,
      {
        applyLatest: vi.fn().mockResolvedValue('unchanged'),
      },
      liability,
    );
    await expect(service.handleLatest('org-one', active)).rejects.toThrow(
      'reconcile Stripe',
    );
    expect(gateway.reverseTransfer).not.toHaveBeenCalled();
  });
});
