import { Temporal } from '@js-temporal/polyfill';
import { expand } from '@shared/recurrence';
import type { Occurrence, Recurrence } from '@shared/recurrence';
import { useCallback, useEffect, useState } from 'react';

import { Button, Field, Select } from '../../ui';

import '../../console/schedule/schedule.css';

type PracticeAllocation = {
  id: string;
  recurrence: Recurrence;
  starts_on: string;
  ends_on: string;
  start_time: string;
  end_time: string;
  purpose: string;
  space_name: string;
  timezone: string | null;
  requested_starts_at: string[];
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (
    init?.method &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(init.method.toUpperCase())
  )
    headers.set('X-Athlentry-Request', '1');
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
  const value =
    response.status === 204
      ? null
      : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const errorValue =
      value && typeof value === 'object' && 'error' in value
        ? value.error
        : value;
    const message =
      errorValue &&
      typeof errorValue === 'object' &&
      'message' in errorValue &&
      typeof errorValue.message === 'string'
        ? errorValue.message
        : `Request failed (${String(response.status)}).`;
    throw new Error(message);
  }
  return value as T;
}

function minutesSinceMidnight(value: string): number {
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0) + seconds / 60;
}

function availableSlots(
  allocation: PracticeAllocation,
  now: number,
): Occurrence[] {
  const timezone = allocation.timezone ?? 'UTC';
  const today = Temporal.Now.plainDateISO(timezone);
  // PostgreSQL DATE values are serialized by node-postgres as UTC timestamps.
  // Keep their calendar portion so Temporal receives a plain date either way.
  const startsOn = Temporal.PlainDate.from(allocation.starts_on.slice(0, 10));
  const endsOn = Temporal.PlainDate.from(allocation.ends_on.slice(0, 10));
  const from =
    Temporal.PlainDate.compare(startsOn, today) > 0 ? startsOn : today;
  const horizon = from.add({ days: 60 });
  const to = Temporal.PlainDate.compare(endsOn, horizon) < 0 ? endsOn : horizon;
  if (Temporal.PlainDate.compare(from, to) > 0) return [];
  const durationMinutes =
    minutesSinceMidnight(allocation.end_time) -
    minutesSinceMidnight(allocation.start_time);
  const unavailable = new Set(
    allocation.requested_starts_at.map((value) => new Date(value).getTime()),
  );
  return expand(
    {
      recurrence: allocation.recurrence,
      startTime: allocation.start_time,
      durationMinutes,
      timezone,
    },
    from.toString(),
    to.toString(),
  ).filter(
    (slot) =>
      new Date(slot.startsAt).getTime() > now &&
      !unavailable.has(new Date(slot.startsAt).getTime()),
  );
}

export function PracticeSlotPicker({
  orgId,
  teamSeasonId,
}: {
  orgId: string;
  teamSeasonId: string;
}): React.JSX.Element {
  const [allocations, setAllocations] = useState<PracticeAllocation[]>([]);
  const [selectedSlots, setSelectedSlots] = useState<Record<string, string>>(
    {},
  );
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await request<{ items: PracticeAllocation[] }>(
        `/api/v1/scheduling/orgs/${encodeURIComponent(orgId)}/team-seasons/${encodeURIComponent(teamSeasonId)}/practice-allocations`,
      );
      setAllocations(result.items);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Allocated practice times could not be loaded.',
      );
    }
  }, [orgId, teamSeasonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function requestSlot(
    allocation: PracticeAllocation,
    slots: Occurrence[],
  ): Promise<void> {
    const slot = slots.find(
      (item) => item.startsAt === selectedSlots[allocation.id],
    );
    if (!slot) return;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await request<{ status: string }>(
        `/api/v1/scheduling/orgs/${encodeURIComponent(orgId)}/allocations/${encodeURIComponent(allocation.id)}/requests`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          }),
        },
      );
      setMessage(
        result.status === 'pending'
          ? 'Your practice slot request is waiting for scheduler approval.'
          : 'Your practice slot is confirmed.',
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Your practice slot could not be requested.',
      );
    } finally {
      setLoading(false);
    }
  }

  const now = Date.now();
  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Team practice</p>
          <h1>Request an allocated practice slot</h1>
          <p>Choose an open time from the team’s allocated practice blocks.</p>
        </div>
        <Button secondary onClick={() => void load()} disabled={loading}>
          Refresh times
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!error && !allocations.length && (
        <section className="schedule-card">
          <p>No open practice allocations are available for this team.</p>
        </section>
      )}
      {allocations.map((allocation) => {
        const timezone = allocation.timezone ?? 'UTC';
        const slots = availableSlots(allocation, now);
        return (
          <section className="schedule-card" key={allocation.id}>
            <h2>{allocation.space_name}</h2>
            <p>
              {allocation.purpose} · {allocation.start_time.slice(0, 5)}–
              {allocation.end_time.slice(0, 5)} · {timezone}
            </p>
            {slots.length ? (
              <form
                className="schedule-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void requestSlot(allocation, slots);
                }}
              >
                <Field label="Available practice slot" required>
                  <Select
                    required
                    value={selectedSlots[allocation.id] ?? ''}
                    onChange={(event) => {
                      setSelectedSlots({
                        ...selectedSlots,
                        [allocation.id]: event.target.value,
                      });
                    }}
                  >
                    <option value="">Choose a date and time</option>
                    {slots.map((slot) => (
                      <option key={slot.startsAt} value={slot.startsAt}>
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: timezone,
                        }).format(new Date(slot.startsAt))}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  type="submit"
                  disabled={loading || !selectedSlots[allocation.id]}
                >
                  Request this slot
                </Button>
              </form>
            ) : (
              <p>No open times are available in the next 60 days.</p>
            )}
          </section>
        );
      })}
    </main>
  );
}
