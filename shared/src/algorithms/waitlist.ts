import { Temporal } from '@js-temporal/polyfill';

export type WaitlistEntry = {
  id: string;
  offeringId: string;
  programId: string;
  personId: string;
  joinedAt: string;
  position: number;
  status: 'waiting' | 'offered' | 'accepted' | 'declined' | 'expired';
  timezone: string;
};
export type WaitlistOffer = {
  entryId: string;
  sendAt: string;
  expiresAt: string;
  holdCount: 1;
};
export type WaitlistInput = {
  entries: readonly WaitlistEntry[];
  offeringId: string;
  capacity: number | null;
  confirmed: number;
  held: number;
  mode: 'auto' | 'manual' | 'off';
  now: string;
  offerExpiryHours?: number;
  manualEntryId?: string;
};

function sendTime(now: Temporal.Instant, timezone: string): Temporal.Instant {
  const local = now.toZonedDateTimeISO(timezone);
  if (local.hour >= 8 && local.hour < 21) return now;
  const date =
    local.hour >= 21
      ? local.toPlainDate().add({ days: 1 })
      : local.toPlainDate();
  return date
    .toPlainDateTime('08:00')
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant();
}

export function nextWaitlistOffer(input: WaitlistInput): WaitlistOffer | null {
  if (
    ![input.confirmed, input.held].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
    throw new RangeError('Invalid capacity counts');
  if (
    input.capacity !== null &&
    (!Number.isSafeInteger(input.capacity) ||
      input.capacity < 0 ||
      input.confirmed + input.held > input.capacity)
  )
    throw new RangeError('Invalid capacity');
  if (
    input.mode === 'off' ||
    (input.capacity !== null && input.confirmed + input.held >= input.capacity)
  )
    return null;
  const hours = input.offerExpiryHours ?? 48;
  if (!Number.isSafeInteger(hours) || hours < 4)
    throw new RangeError('Offer expiry must be at least four hours');
  const active = new Set(
    input.entries
      .filter((entry) => entry.status === 'offered')
      .map((entry) => `${entry.programId}:${entry.personId}`),
  );
  const eligible = input.entries.filter(
    (entry) =>
      entry.offeringId === input.offeringId &&
      entry.status === 'waiting' &&
      !active.has(`${entry.programId}:${entry.personId}`),
  );
  const entry =
    input.mode === 'manual'
      ? eligible.find((item) => item.id === input.manualEntryId)
      : [...eligible].sort(
          (a, b) =>
            a.position - b.position ||
            a.joinedAt.localeCompare(b.joinedAt) ||
            a.id.localeCompare(b.id),
        )[0];
  if (!entry) return null;
  const sendAt = sendTime(Temporal.Instant.from(input.now), entry.timezone);
  return {
    entryId: entry.id,
    sendAt: sendAt.toString(),
    expiresAt: sendAt.add({ hours }).toString(),
    holdCount: 1,
  };
}
