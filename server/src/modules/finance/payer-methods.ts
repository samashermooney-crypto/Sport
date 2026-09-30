import type {
  GatewayPaymentMethod,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';

export type PayerReservation =
  | { kind: 'existing'; customerId: string }
  | { kind: 'reserved' }
  | { kind: 'busy' };

export class PayerMethodConflictError extends Error {}

/**
 * Global account-scoped repository. reserve permanently fences an uncertain
 * Stripe customer creation until a reconciler locates it by account metadata.
 * save is idempotent and has a unique account_id and stripe_customer_id.
 */
export interface PayerProfileRepository {
  reserve(accountId: string): Promise<PayerReservation>;
  save(accountId: string, customerId: string): Promise<void>;
  load(accountId: string): Promise<string | null>;
  findAccountByCustomer(customerId: string): Promise<string | null>;
}

export interface SavedPaymentMethodRepository {
  sync(
    accountId: string,
    methods: readonly GatewayPaymentMethod[],
  ): Promise<void>;
  setDefault(accountId: string, paymentMethodId: string): Promise<void>;
  markDetached(accountId: string, paymentMethodId: string): Promise<void>;
  findOwner(paymentMethodId: string): Promise<string | null>;
}

type PayerMethodsGateway = Pick<
  PaymentsGateway,
  | 'createCustomer'
  | 'createSetupIntent'
  | 'listPaymentMethods'
  | 'detachPaymentMethod'
  | 'setDefaultPaymentMethod'
>;

export class PayerMethodsService {
  private readonly gatewayProvider: () => PayerMethodsGateway;

  constructor(
    private readonly profiles: PayerProfileRepository,
    gateway: PayerMethodsGateway | (() => PayerMethodsGateway),
    private readonly methods?: SavedPaymentMethodRepository,
  ) {
    this.gatewayProvider =
      typeof gateway === 'function' ? gateway : () => gateway;
  }

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
    return this.gatewayProvider().createSetupIntent({
      customerId,
      idempotencyKey: `setup:${input.accountId}:${input.idempotencyKey}`,
    });
  }

  async list(accountId: string): Promise<GatewayPaymentMethod[]> {
    const customerId = await this.profiles.load(accountId);
    if (!customerId) return [];
    const methods = await this.gatewayProvider().listPaymentMethods(customerId);
    await this.methods?.sync(accountId, methods);
    return methods;
  }

  async remove(accountId: string, paymentMethodId: string): Promise<void> {
    await this.requireOwnedMethod(accountId, paymentMethodId);
    await this.gatewayProvider().detachPaymentMethod(paymentMethodId);
    await this.methods?.markDetached(accountId, paymentMethodId);
  }

  async setDefault(accountId: string, paymentMethodId: string): Promise<void> {
    const customerId = await this.requireOwnedMethod(
      accountId,
      paymentMethodId,
    );
    await this.gatewayProvider().setDefaultPaymentMethod(
      customerId,
      paymentMethodId,
    );
    await this.methods?.setDefault(accountId, paymentMethodId);
  }

  private async requireOwnedMethod(
    accountId: string,
    paymentMethodId: string,
  ): Promise<string> {
    const customerId = await this.profiles.load(accountId);
    if (!customerId)
      throw new PayerMethodConflictError('Payer has no Stripe Customer');
    const methods = await this.gatewayProvider().listPaymentMethods(customerId);
    if (!methods.some((method) => method.id === paymentMethodId))
      throw new PayerMethodConflictError(
        'Payment method is not attached to this payer',
      );
    await this.methods?.sync(accountId, methods);
    return customerId;
  }

  async ensureCustomer(accountId: string, email: string): Promise<string> {
    const reservation = await this.profiles.reserve(accountId);
    if (reservation.kind === 'existing') return reservation.customerId;
    if (reservation.kind === 'busy') {
      throw new PayerMethodConflictError(
        'Stripe customer creation is already in progress',
      );
    }
    const customer = await this.gatewayProvider().createCustomer({
      accountId,
      email,
      idempotencyKey: `payer:${accountId}`,
    });
    await this.profiles.save(accountId, customer.id);
    return customer.id;
  }
}
