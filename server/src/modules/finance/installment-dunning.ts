import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

export interface InstallmentChargeClaim {
  id: string;
  leaseToken: string;
  orgId: string;
  installmentId: string;
  invoiceId: string;
  accountId: string;
  customerId: string;
  connectedAccountId: string;
  paymentMethodId: string;
  method: 'card' | 'us_bank_account' | 'link';
  attemptNumber: number;
  amountCents: number;
  applicationFeeCents: number;
}

export interface InstallmentChargeRepository {
  claimDue(orgId: string, now: string): Promise<InstallmentChargeClaim | null>;
  beginExternal(claim: InstallmentChargeClaim): Promise<void>;
  recordIntent(
    claim: InstallmentChargeClaim,
    paymentIntentId: string,
  ): Promise<void>;
}

/** A started Stripe call stays fenced until its exact outcome is reconciled. */
export class InstallmentDunningService {
  constructor(
    private readonly repository: InstallmentChargeRepository,
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveAccount' | 'createDestinationPayment'
    >,
  ) {}

  async chargeOne(
    orgId: string,
    now: string,
  ): Promise<{ kind: 'none' } | { kind: 'created'; paymentIntentId: string }> {
    const claim = await this.repository.claimDue(orgId, now);
    if (!claim) return { kind: 'none' };
    const account = await this.gateway.retrieveAccount(
      claim.connectedAccountId,
    );
    if (!account.chargesEnabled)
      throw new Error('Connected Stripe account cannot accept charges');
    await this.repository.beginExternal(claim);
    const intent = await this.gateway.createDestinationPayment({
      amountCents: claim.amountCents,
      applicationFeeCents: claim.applicationFeeCents,
      customerId: claim.customerId,
      connectedAccountId: claim.connectedAccountId,
      orgId: claim.orgId,
      invoiceId: claim.invoiceId,
      installmentId: claim.installmentId,
      idempotencyKey: `inst:${claim.installmentId}:${String(claim.attemptNumber)}`,
      saveForAutopay: false,
      paymentMethodId: claim.paymentMethodId,
      offSession: true,
    });
    if (
      intent.amountCents !== claim.amountCents ||
      !intent.id.startsWith('pi_')
    )
      throw new Error(
        'Stripe installment PaymentIntent differs from claimed amount',
      );
    await this.repository.recordIntent(claim, intent.id);
    return { kind: 'created', paymentIntentId: intent.id };
  }
}
