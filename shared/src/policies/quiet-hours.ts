import { Temporal } from '@js-temporal/polyfill';

export type DeliveryChannel = 'email' | 'sms' | 'push' | 'in_app';
export type QuietHoursResult = { sendNow: boolean; nextSendAt: string | null };

export function quietHoursDecision(
  instant: string,
  timezone: string,
  channel: DeliveryChannel,
  emergency: boolean,
): QuietHoursResult {
  if (emergency || channel === 'email' || channel === 'in_app')
    return { sendNow: true, nextSendAt: null };
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  const hour = local.hour;
  if (hour >= 8 && hour < 21) return { sendNow: true, nextSendAt: null };
  const nextDate =
    hour >= 21 ? local.toPlainDate().add({ days: 1 }) : local.toPlainDate();
  const next = nextDate
    .toPlainDateTime('08:00')
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant();
  return { sendNow: false, nextSendAt: next.toString() };
}
