import { randomUUID } from 'node:crypto';

import type { GuestDonationCheckoutPort } from './checkout';

/**
 * Development/test stand-in for the hosted guest donation checkout until the
 * payment boundary adapter lands. It redirects straight to a preview completion
 * route that finalizes the pending donation, mirroring the provider's
 * hosted-checkout redirect. Never used in production.
 */
export class PreviewGuestDonationCheckout implements GuestDonationCheckoutPort {
  constructor(private readonly appUrl: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- port contract is async; the preview adapter resolves synchronously
  async create(input: {
    orgId: string;
    campaignId: string;
    donationId: string;
    amountCents: number;
    donorName: string;
    donorEmail: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ checkoutSessionId: string; url: string }> {
    const checkoutSessionId = `preview_${randomUUID()}`;
    return {
      checkoutSessionId,
      url: `${this.appUrl}/api/v1/fundraising/preview-checkout/${input.orgId}/${checkoutSessionId}/complete?donation=${input.donationId}`,
    };
  }
}
