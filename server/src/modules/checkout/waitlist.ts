import { Temporal } from '@js-temporal/polyfill';
import { quietHoursDecision } from '@shared/policies/quiet-hours';

export interface WaitlistOffer {
  entryId: string;
  personId: string;
  offeringId: string;
  sendAt: string;
  expiresAt: string;
}

/**
 * offerNext is one withOrg transaction: select the next waiting entry, enforce
 * one active offer per participant/program, increment capacity held, record the
 * offer and insert its notification into an outbox. All steps commit together.
 */
export interface WaitlistOfferRepository {
  offerNext(input: {
    orgId: string;
    offeringId: string;
    selectedEntryId?: string;
    sendAt: string;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<WaitlistOffer | 'full' | 'empty'>;
  accept(input: {
    orgId: string;
    entryId: string;
    checkoutId: string;
    at: string;
  }): Promise<'accepted' | 'expired' | 'not_offered'>;
  declineOrExpire(input: {
    orgId: string;
    entryId: string;
    at: string;
    reason: 'declined' | 'expired';
  }): Promise<boolean>;
}

export function offerWindow(
  now: string,
  familyTimezone: string,
  expiryHours = 48,
) {
  if (!Number.isSafeInteger(expiryHours) || expiryHours < 4) {
    throw new RangeError('Offer expiry must be at least 4 hours');
  }
  const quiet = quietHoursDecision(now, familyTimezone, 'push', false);
  const sendAt = quiet.sendNow ? now : quiet.nextSendAt;
  if (!sendAt) throw new Error('Waitlist offer send time is missing');
  return {
    sendAt,
    expiresAt: Temporal.Instant.from(sendAt)
      .add({ hours: expiryHours })
      .toString(),
  };
}

export class WaitlistOfferService {
  constructor(private readonly repository: WaitlistOfferRepository) {}

  async offerNext(input: {
    orgId: string;
    offeringId: string;
    selectedEntryId?: string;
    now: string;
    familyTimezone: string;
    expiryHours?: number;
    idempotencyKey: string;
  }) {
    const window = offerWindow(
      input.now,
      input.familyTimezone,
      input.expiryHours,
    );
    return this.repository.offerNext({
      orgId: input.orgId,
      offeringId: input.offeringId,
      ...(input.selectedEntryId
        ? { selectedEntryId: input.selectedEntryId }
        : {}),
      ...window,
      idempotencyKey: input.idempotencyKey,
    });
  }

  accept(input: {
    orgId: string;
    entryId: string;
    checkoutId: string;
    at: string;
  }) {
    return this.repository.accept(input);
  }

  decline(input: { orgId: string; entryId: string; at: string }) {
    return this.repository.declineOrExpire({ ...input, reason: 'declined' });
  }

  expire(input: { orgId: string; entryId: string; at: string }) {
    return this.repository.declineOrExpire({ ...input, reason: 'expired' });
  }
}
