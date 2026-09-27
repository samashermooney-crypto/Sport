/** Implemented by the payment boundary. It must create a guest checkout against
 * the organization's connected account and return a provider-hosted URL. */
export interface GuestDonationCheckoutPort {
  create(input: {
    orgId: string;
    campaignId: string;
    donationId: string;
    amountCents: number;
    donorName: string;
    donorEmail: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ checkoutSessionId: string; url: string }>;
}
