import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

export interface ConnectAccount {
  orgId: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: readonly string[];
  disabledReason: string | null;
}

export type ConnectReservation =
  | { kind: 'existing'; account: ConnectAccount }
  | { kind: 'reserved' }
  | { kind: 'busy' };

/**
 * Every method runs inside withOrg; reserve and save are atomic per org.
 * A reserved org remains blocked after an uncertain Stripe failure until
 * reconciliation finds the account by org metadata. Stripe idempotency keys
 * alone are not durable enough to safely release the reservation.
 */
export interface ConnectAccountRepository {
  reserve(orgId: string): Promise<ConnectReservation>;
  saveCreated(account: ConnectAccount): Promise<void>;
  load(orgId: string): Promise<ConnectAccount | null>;
  update(account: ConnectAccount): Promise<void>;
}

export interface ConnectOnboardingUrls {
  returnUrl: (orgId: string) => string;
  refreshUrl: (orgId: string) => string;
}

function assertHttpsUrl(url: string): void {
  if (new URL(url).protocol !== 'https:') {
    throw new Error('Connect onboarding URLs must use HTTPS');
  }
}

export class ConnectOnboardingService {
  constructor(
    private readonly repository: ConnectAccountRepository,
    private readonly gateway: Pick<
      PaymentsGateway,
      | 'createExpressAccount'
      | 'createAccountLink'
      | 'createExpressLoginLink'
      | 'retrieveAccount'
    >,
    private readonly urls: ConnectOnboardingUrls,
  ) {}

  async create(orgId: string, email: string): Promise<{ url: string }> {
    const reservation = await this.repository.reserve(orgId);
    if (reservation.kind === 'busy') {
      throw new Error('Stripe account creation is already in progress');
    }
    if (reservation.kind === 'existing') {
      return this.onboardingLink(orgId, reservation.account.stripeAccountId);
    }
    const created = await this.gateway.createExpressAccount({
      orgId,
      email,
      idempotencyKey: `connect:${orgId}`,
    });
    const latest = await this.gateway.retrieveAccount(created.id);
    if (latest.id !== created.id) {
      throw new Error('Stripe returned a different connected account');
    }
    await this.repository.saveCreated(this.accountView(orgId, latest));
    return this.onboardingLink(orgId, created.id);
  }

  async continue(orgId: string): Promise<{ url: string }> {
    const account = await this.requireAccount(orgId);
    return this.onboardingLink(orgId, account.stripeAccountId);
  }

  async dashboard(orgId: string): Promise<{ url: string }> {
    const account = await this.requireAccount(orgId);
    const latest = await this.refresh(orgId, account.stripeAccountId);
    if (!latest.chargesEnabled || !latest.payoutsEnabled) {
      throw new Error('Stripe payments and payouts are not yet enabled');
    }
    return this.gateway.createExpressLoginLink(account.stripeAccountId);
  }

  /** account.updated uses the event only as a hint; Stripe is the latest state. */
  async refresh(
    orgId: string,
    stripeAccountId: string,
  ): Promise<ConnectAccount> {
    const current = await this.requireAccount(orgId);
    if (current.stripeAccountId !== stripeAccountId) {
      throw new Error('Connected account does not belong to this organization');
    }
    const latest = await this.gateway.retrieveAccount(stripeAccountId);
    if (latest.id !== stripeAccountId) {
      throw new Error('Stripe returned a different connected account');
    }
    const account = this.accountView(orgId, latest);
    await this.repository.update(account);
    return account;
  }

  private async requireAccount(orgId: string): Promise<ConnectAccount> {
    const account = await this.repository.load(orgId);
    if (!account) throw new Error('Stripe account has not been created');
    return account;
  }

  private onboardingLink(
    orgId: string,
    accountId: string,
  ): Promise<{ url: string }> {
    const returnUrl = this.urls.returnUrl(orgId);
    const refreshUrl = this.urls.refreshUrl(orgId);
    assertHttpsUrl(returnUrl);
    assertHttpsUrl(refreshUrl);
    return this.gateway.createAccountLink({ accountId, returnUrl, refreshUrl });
  }

  private accountView(
    orgId: string,
    account: Awaited<ReturnType<PaymentsGateway['retrieveAccount']>>,
  ): ConnectAccount {
    return {
      orgId,
      stripeAccountId: account.id,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      detailsSubmitted: account.detailsSubmitted,
      requirementsDue: account.requirements.currentlyDue,
      disabledReason: account.requirements.disabledReason,
    };
  }
}
