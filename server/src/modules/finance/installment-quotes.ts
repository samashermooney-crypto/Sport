import {
  applicationFee,
  serviceFeesForCharges,
  type FeeRate,
  type ServiceFeeConfig,
} from '@shared/algorithms/fees';
import {
  generateInstallments,
  type InstallmentTemplate,
} from '@shared/algorithms/installments';

export interface PlannedCharge {
  dueOn: string;
  baseCents: number;
  serviceFeeCents: number;
  amountCents: number;
  applicationFeeCents: number;
}

export interface InstallmentQuote {
  deposit: PlannedCharge;
  installments: PlannedCharge[];
  baseTotalCents: number;
  serviceFeeTotalCents: number;
  payableTotalCents: number;
}

function safeCents(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Installment quote exceeds safe integer cents');
  }
  return Number(value);
}

/** The input total already reflects discounts, aid, credits and product tax. */
export function quoteInstallmentPlan(input: {
  totalDueCents: number;
  template: InstallmentTemplate;
  todayLocal: string;
  serviceFee: ServiceFeeConfig;
  applicationRate: FeeRate;
}): InstallmentQuote | null {
  if (
    input.serviceFee.enabled &&
    input.serviceFee.mode === 'cover_costs' &&
    (input.serviceFee.application.bps !== input.applicationRate.bps ||
      input.serviceFee.application.fixedCents !==
        input.applicationRate.fixedCents)
  ) {
    throw new Error('Service fee and application fee settings disagree');
  }
  const plan = generateInstallments(
    input.totalDueCents,
    input.template,
    input.todayLocal,
  );
  if (!plan) return null;
  const bases = [
    plan.depositCents,
    ...plan.installments.map((item) => item.amountCents),
  ];
  const fees = serviceFeesForCharges(bases, input.serviceFee);
  const charges = bases.map((baseCents, index): PlannedCharge => {
    const serviceFeeCents = fees[index] ?? 0;
    const amountCents = safeCents(BigInt(baseCents) + BigInt(serviceFeeCents));
    const installment = plan.installments[index - 1];
    if (index > 0 && !installment) {
      throw new Error('Installment date missing');
    }
    return {
      dueOn: installment?.dueOn ?? input.todayLocal,
      baseCents,
      serviceFeeCents,
      amountCents,
      applicationFeeCents: applicationFee(amountCents, input.applicationRate),
    };
  });
  const deposit = charges[0];
  if (!deposit) throw new Error('Installment deposit missing');
  const installments = charges.slice(1);
  const baseTotalCents = safeCents(
    charges.reduce((sum, charge) => sum + BigInt(charge.baseCents), 0n),
  );
  if (baseTotalCents !== input.totalDueCents) {
    throw new Error('Installment bases do not reconcile');
  }
  const serviceFeeTotalCents = safeCents(
    charges.reduce((sum, charge) => sum + BigInt(charge.serviceFeeCents), 0n),
  );
  const payableTotalCents = safeCents(
    BigInt(baseTotalCents) + BigInt(serviceFeeTotalCents),
  );
  return {
    deposit,
    installments,
    baseTotalCents,
    serviceFeeTotalCents,
    payableTotalCents,
  };
}
