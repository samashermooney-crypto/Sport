import { Temporal } from '@js-temporal/polyfill';

const nonRetryable = new Set([
  'expired_card',
  'incorrect_number',
  'stolen_card',
  'lost_card',
  'authentication_required',
]);
const retryDelaysDays = [1, 3, 7] as const;

export type RetryDecision = {
  retry: boolean;
  nextAttemptAt: string | null;
  requiresPaymentMethodUpdate: boolean;
  finalFailure: boolean;
};

export function firstInstallmentAttemptAt(
  dueOn: string,
  timezone: string,
): string {
  return Temporal.PlainDate.from(dueOn)
    .toPlainDateTime('10:00')
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString();
}

export function nextInstallmentAttempt(
  failedAt: string,
  attemptNumber: number,
  errorCode: string,
  timezone: string,
): RetryDecision {
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > 4
  )
    throw new RangeError('Attempt number must be 1–4');
  if (nonRetryable.has(errorCode))
    return {
      retry: false,
      nextAttemptAt: null,
      requiresPaymentMethodUpdate: true,
      finalFailure: true,
    };
  const delay = retryDelaysDays[attemptNumber - 1];
  if (delay === undefined)
    return {
      retry: false,
      nextAttemptAt: null,
      requiresPaymentMethodUpdate: false,
      finalFailure: true,
    };
  const local = Temporal.Instant.from(failedAt).toZonedDateTimeISO(timezone);
  const next = local
    .toPlainDate()
    .add({ days: delay })
    .toPlainDateTime('10:00')
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant();
  return {
    retry: true,
    nextAttemptAt: next.toString(),
    requiresPaymentMethodUpdate: false,
    finalFailure: false,
  };
}

export function cardExpiryNoticeOn(installmentDueOn: string): string {
  return Temporal.PlainDate.from(installmentDueOn)
    .subtract({ days: 14 })
    .toString();
}
