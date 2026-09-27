import { Temporal } from '@js-temporal/polyfill';

export type CapacityCounter = {
  subject: 'program' | 'division' | 'offering';
  id: string;
  capacity: number | null;
  confirmed: number;
  held: number;
};
export type CapacityChange = 'hold' | 'confirm' | 'release' | 'withdraw';

function valid(counter: CapacityCounter): void {
  for (const [name, value] of [
    ['confirmed', counter.confirmed],
    ['held', counter.held],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (
    counter.capacity !== null &&
    (!Number.isSafeInteger(counter.capacity) ||
      counter.capacity < 0 ||
      counter.confirmed + counter.held > counter.capacity)
  )
    throw new RangeError('Invalid capacity counter');
}

const subjectOrder = { program: 0, division: 1, offering: 2 } as const;

export function changeCapacity(
  counters: readonly CapacityCounter[],
  action: CapacityChange,
): CapacityCounter[] {
  const ordered = [...counters].sort(
    (a, b) =>
      subjectOrder[a.subject] - subjectOrder[b.subject] ||
      a.id.localeCompare(b.id),
  );
  if (
    new Set(ordered.map((counter) => `${counter.subject}:${counter.id}`))
      .size !== ordered.length
  )
    throw new RangeError('Duplicate capacity counter');
  ordered.forEach(valid);
  return ordered.map((counter) => {
    const next = { ...counter };
    if (action === 'hold') next.held += 1;
    else if (action === 'confirm') {
      next.held -= 1;
      next.confirmed += 1;
    } else if (action === 'release') next.held -= 1;
    else next.confirmed -= 1;
    valid(next);
    return next;
  });
}

export function holdExpiresAt(
  createdAt: string,
  lastActivityAt: string,
): string {
  const created = Temporal.Instant.from(createdAt);
  const activity = Temporal.Instant.from(lastActivityAt);
  if (Temporal.Instant.compare(activity, created) < 0)
    throw new RangeError('Activity precedes hold creation');
  const maximum = created.add({ minutes: 45 });
  const extended = activity.add({ minutes: 20 });
  return (
    Temporal.Instant.compare(extended, maximum) > 0 ? maximum : extended
  ).toString();
}

export function shouldKeepProcessingHold(
  checkoutStatus: string,
  processingStartedAt: string | null,
  expiresAt: string,
): boolean {
  return (
    checkoutStatus === 'awaiting_payment' &&
    processingStartedAt !== null &&
    Temporal.Instant.compare(
      Temporal.Instant.from(processingStartedAt),
      Temporal.Instant.from(expiresAt),
    ) <= 0
  );
}
