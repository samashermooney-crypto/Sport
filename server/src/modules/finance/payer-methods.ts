import type {
  GatewayPaymentMethod,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';

export type PayerReservation =
  | { kind: 'existing'; customerId: string }
  | { kind: 'reserved' }
  | { kind: 'busy' };

/**
 * Global account-scoped repository. reserve permanently fences an uncertain
 * Stripe customer creation until a reconciler locates it by account metadata.
 * save is idempotent and has a unique account_id and stripe_customer_id.
 */
export interface PayerProfileRepository {
  reserve(accountId: string): Promise<PayerReservation>;
  save(accountId: string, customerId: string): Promise<void>;
  load(accountId: string): Promise<string | null>;
}

export class PayerMethodsService {
  constructor(
    private readonly profiles: PayerProfileRepository,
    private readonly gateway: Pick<
      PaymentsGateway,
      'createCustomer' | 'createSetupIntent' | 'listPaymentMethods'
    >,
  ) {}

  async createSetupIntent(input: {
    accountId: string;
    email: string;
    idempotencyKey: string;
  }): Promise<{ id: string; clientSecret: string }> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    ) {
      throw new Error('Idempotency-Key must be a UUID');
    }
    const customerId = await this.ensureCustomer(input.accountId, input.email);
    return this.gateway.createSetupIntent({
      customerId,
      idempotencyKey: `setup:${input.accountId}:${input.idempotencyKey}`,
    });
  }

  async list(accountId: string): Promise<GatewayPaymentMethod[]> {
    const customerId = await this.profiles.load(accountId);
    return customerId ? this.gateway.listPaymentMethods(customerId) : [];
  }

  private async ensureCustomer(accountId: string, email: string) {
    const reservation = await this.profiles.reserve(accountId);
    if (reservation.kind === 'existing') return reservation.customerId;
    if (reservation.kind === 'busy') {
      throw new Error('Stripe customer creation is already in progress');
    }
    const customer = await this.gateway.createCustomer({
      accountId,
      email,
      idempotencyKey: `payer:${accountId}`,
    });
    await this.profiles.save(accountId, customer.id);
    return customer.id;
  }
}
