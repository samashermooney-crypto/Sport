import { percentOf } from '../money.js';

export type FeeRate = { bps: number; fixedCents: number };
export type ServiceFeeConfig =
  | { enabled: false }
  | {
      enabled: true;
      mode: 'cover_costs';
      application: FeeRate;
      processing?: FeeRate;
    }
  | { enabled: true; mode: 'custom'; custom: FeeRate };

function integer(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
  return BigInt(value);
}

function numberFrom(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new RangeError('Fee exceeds the safe integer range');
  return converted;
}

export function applicationFee(
  amountChargedCents: number,
  rate: FeeRate,
): number {
  integer(amountChargedCents, 'amountChargedCents');
  integer(rate.bps, 'application bps');
  integer(rate.fixedCents, 'application fixed cents');
  if (amountChargedCents === 0) return 0;
  return Math.min(
    amountChargedCents - 1,
    percentOf(amountChargedCents, rate.bps) + rate.fixedCents,
  );
}

export function serviceFee(
  baseChargedCents: number,
  config: ServiceFeeConfig,
): number {
  const base = integer(baseChargedCents, 'baseChargedCents');
  if (!config.enabled || base === 0n) return 0;
  if (config.mode === 'custom') {
    integer(config.custom.bps, 'custom bps');
    integer(config.custom.fixedCents, 'custom fixed cents');
    return (
      percentOf(baseChargedCents, config.custom.bps) + config.custom.fixedCents
    );
  }
  const processing = config.processing ?? { bps: 290, fixedCents: 30 };
  const bps =
    integer(config.application.bps, 'application bps') +
    integer(processing.bps, 'processing bps');
  const fixed =
    integer(config.application.fixedCents, 'application fixed cents') +
    integer(processing.fixedCents, 'processing fixed cents');
  if (bps >= 10_000n)
    throw new RangeError('Combined fee rate must be below 100%');
  const numerator = (base + fixed) * 10_000n;
  const total = (numerator + (10_000n - bps) - 1n) / (10_000n - bps);
  return numberFrom(total - base);
}

export function serviceFeesForCharges(
  chargesCents: readonly number[],
  config: ServiceFeeConfig,
): number[] {
  return chargesCents.map((charge) => serviceFee(charge, config));
}
