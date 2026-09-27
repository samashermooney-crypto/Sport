import { Temporal } from '@js-temporal/polyfill';
import { useMemo, useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button, Field, Input, Select } from '../../ui';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export type ResourceScheduleEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  version: number;
  spaceId: string | null;
  locationText?: string | null;
};

export type ScheduleResource = {
  id: string;
  name: string;
  timezone?: string;
};

export type ResourceMoveHandler = (
  event: ResourceScheduleEvent,
  destination: {
    startsAt: string;
    endsAt: string;
    spaceId: string | null;
    timezone: string;
    overrideReason?: string;
  },
) => Promise<void>;

function timeLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: 'numeric',
  });
}

function timeValue(event: ResourceScheduleEvent): string {
  return Temporal.Instant.from(event.startsAt)
    .toZonedDateTimeISO(event.timezone)
    .toPlainTime()
    .toString({ smallestUnit: 'minute' });
}

function eventDate(event: ResourceScheduleEvent): string {
  return Temporal.Instant.from(event.startsAt)
    .toZonedDateTimeISO(event.timezone)
    .toPlainDate()
    .toString();
}

function rangeAt(
  event: ResourceScheduleEvent,
  date: string,
  time: string,
  timezone: string,
): { startsAt: string; endsAt: string } {
  const [hourText, minuteText] = time.split(':');
  const start = Temporal.PlainDate.from(date)
    .toPlainDateTime({
      hour: Number(hourText),
      minute: Number(minuteText),
    })
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant();
  const duration =
    Temporal.Instant.from(event.endsAt).epochMilliseconds -
    Temporal.Instant.from(event.startsAt).epochMilliseconds;
  const end = start.add({ milliseconds: duration });
  return { startsAt: start.toString(), endsAt: end.toString() };
}

function canMove(event: ResourceScheduleEvent): boolean {
  return event.status === 'scheduled' || event.status === 'postponed';
}

export function ResourceScheduleCalendar({
  events,
  resources,
  timezone,
  initialDate,
  onMove,
}: {
  events: readonly ResourceScheduleEvent[];
  resources: readonly ScheduleResource[];
  timezone: string;
  initialDate?: string;
  onMove: ResourceMoveHandler;
}): React.JSX.Element {
  const [date, setDate] = useState(
    () => initialDate ?? Temporal.Now.plainDateISO(timezone).toString(),
  );
  const [selectedId, setSelectedId] = useState('');
  const [targetDate, setTargetDate] = useState(date);
  const [targetTime, setTargetTime] = useState('');
  const [targetSpaceId, setTargetSpaceId] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [movingId, setMovingId] = useState('');
  const [moveError, setMoveError] = useState('');
  const [moveMessage, setMoveMessage] = useState('');

  const dayEvents = useMemo(
    () => events.filter((event) => eventDate(event) === date),
    [date, events],
  );
  const resourcesWithUnassigned = useMemo(
    () => [{ id: '', name: 'Unassigned / location only' }, ...resources],
    [resources],
  );
  const selected = dayEvents.find((event) => event.id === selectedId);
  const currentTimeOptions = selected
    ? [
        {
          value: timeValue(selected),
          label: `Current time (${timeValue(selected)})`,
        },
      ]
    : [];

  function changeDate(next: string): void {
    setDate(next);
    setTargetDate(next);
    setSelectedId('');
    setTargetTime('');
    setOverrideReason('');
    setMoveError('');
    setMoveMessage('');
  }

  function chooseEvent(event: ResourceScheduleEvent): void {
    setSelectedId(event.id);
    setTargetDate(date);
    setTargetTime(timeValue(event));
    setTargetSpaceId(event.spaceId ?? '');
    setOverrideReason('');
    setMoveError('');
    setMoveMessage('');
  }

  async function move(
    event: ResourceScheduleEvent,
    destinationDate: string,
    hour: number,
    spaceId: string | null,
  ): Promise<void> {
    if (!canMove(event)) return;
    const start = `${String(hour).padStart(2, '0')}:00`;
    setSelectedId(event.id);
    setTargetDate(destinationDate);
    setTargetTime(start);
    setTargetSpaceId(spaceId ?? '');
    setOverrideReason('');
    await moveTo(
      event,
      destinationDate,
      start,
      spaceId,
      resources.find((resource) => resource.id === spaceId)?.timezone ??
        timezone,
    );
  }

  async function moveTo(
    event: ResourceScheduleEvent,
    destinationDate: string,
    time: string,
    spaceId: string | null,
    destinationTimezone: string,
    reason?: string,
  ): Promise<void> {
    if (!canMove(event) || movingId) return;
    setMovingId(event.id);
    setMoveError('');
    setMoveMessage('');
    try {
      await onMove(event, {
        ...rangeAt(event, destinationDate, time, destinationTimezone),
        spaceId,
        timezone: destinationTimezone,
        ...(reason?.trim() ? { overrideReason: reason.trim() } : {}),
      });
      setSelectedId('');
      setTargetTime('');
      setOverrideReason('');
      setMoveMessage('Event moved; its new space and time are saved.');
    } catch (cause) {
      setMoveError(
        cause instanceof Error
          ? cause.message
          : 'The event could not be moved.',
      );
    } finally {
      setMovingId('');
    }
  }

  function dropOn(
    event: React.DragEvent<HTMLDivElement>,
    spaceId: string | null,
    hour: number,
  ): void {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain');
    const dragged = dayEvents.find((item) => item.id === id);
    if (dragged) {
      void move(dragged, date, hour, spaceId);
    }
  }

  async function submitKeyboardMove(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!selected || !targetDate || !targetTime) return;
    const destinationSpaceId = targetSpaceId || null;
    await moveTo(
      selected,
      targetDate,
      targetTime,
      destinationSpaceId,
      resources.find((resource) => resource.id === destinationSpaceId)
        ?.timezone ?? timezone,
      overrideReason,
    );
  }

  return (
    <section
      className="schedule-card"
      aria-labelledby="resource-calendar-title"
    >
      <div className="schedule-card__title">
        <div>
          <h2 id="resource-calendar-title">Resource calendar</h2>
          <p>
            Drag a scheduled event to a space and start time, or select an event
            and use the keyboard move controls.
          </p>
        </div>
        <div className="schedule-actions" aria-label="Calendar date controls">
          <Button
            secondary
            onClick={() => {
              changeDate(
                Temporal.PlainDate.from(date).subtract({ days: 1 }).toString(),
              );
            }}
            aria-label="Previous day"
          >
            Previous day
          </Button>
          <Button
            secondary
            onClick={() => {
              changeDate(Temporal.Now.plainDateISO(timezone).toString());
            }}
          >
            Today
          </Button>
          <Button
            secondary
            onClick={() => {
              changeDate(
                Temporal.PlainDate.from(date).add({ days: 1 }).toString(),
              );
            }}
            aria-label="Next day"
          >
            Next day
          </Button>
          <strong>
            {Temporal.PlainDate.from(date).toLocaleString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </strong>
        </div>
      </div>

      {(moveError || moveMessage) && (
        <div
          className={`schedule-notice${moveError ? ' schedule-notice--error' : ''}`}
          role={moveError ? 'alert' : 'status'}
        >
          {moveError || moveMessage}
        </div>
      )}

      <div
        className="schedule-resource-scroll"
        role="region"
        aria-label="Scrollable resource calendar"
        tabIndex={0}
      >
        <div
          className="schedule-resource-calendar"
          role="table"
          aria-label={`Resource schedule for ${date}`}
        >
          <div
            className="schedule-resource-row schedule-resource-row--header"
            role="row"
          >
            <strong role="columnheader">Space</strong>
            <div className="schedule-resource-hours" role="presentation">
              {HOURS.map((hour) => (
                <time role="columnheader" key={hour}>
                  {timeLabel(hour)}
                </time>
              ))}
            </div>
          </div>
          {resourcesWithUnassigned.map((resource) => {
            const resourceEvents = dayEvents.filter(
              (event) => (event.spaceId ?? '') === resource.id,
            );
            return (
              <div
                className="schedule-resource-row"
                role="row"
                key={resource.id || 'unassigned'}
              >
                <strong role="rowheader">
                  {resource.name}
                  <small>{resource.timezone ?? timezone}</small>
                </strong>
                <div className="schedule-resource-hours" role="presentation">
                  {HOURS.map((hour) => {
                    const slotEvents = resourceEvents.filter(
                      (event) => Number(timeValue(event).slice(0, 2)) === hour,
                    );
                    return (
                      <div
                        className="schedule-resource-slot"
                        role="cell"
                        aria-label={`${resource.name}, ${timeLabel(hour)}`}
                        key={hour}
                        onDragOver={(event) => {
                          event.preventDefault();
                        }}
                        onDrop={(event) => {
                          dropOn(event, resource.id || null, hour);
                        }}
                      >
                        {slotEvents.map((item) => {
                          const start = Temporal.Instant.from(item.startsAt)
                            .toZonedDateTimeISO(item.timezone)
                            .toPlainTime()
                            .toLocaleString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                            });
                          const end = Temporal.Instant.from(item.endsAt)
                            .toZonedDateTimeISO(item.timezone)
                            .toPlainTime()
                            .toLocaleString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                            });
                          return (
                            <Button
                              key={item.id}
                              secondary
                              className="schedule-resource-event"
                              draggable={canMove(item)}
                              disabled={!canMove(item) || movingId === item.id}
                              aria-label={`Select ${item.title}, ${start} to ${end}`}
                              aria-pressed={selectedId === item.id}
                              onClick={() => {
                                chooseEvent(item);
                              }}
                              onDragStart={(event) => {
                                event.dataTransfer.setData(
                                  'text/plain',
                                  item.id,
                                );
                                event.dataTransfer.effectAllowed = 'move';
                              }}
                            >
                              <span>
                                {start}–{end}
                              </span>
                              <strong>{item.title}</strong>
                            </Button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!dayEvents.length && (
            <p className="schedule-resource-empty">No events on this date.</p>
          )}
        </div>
      </div>

      {selected && canMove(selected) && (
        <form
          className="schedule-form schedule-form--two schedule-resource-move"
          onSubmit={(event) => {
            void submitKeyboardMove(event);
          }}
        >
          <p>
            Move <strong>{selected.title}</strong> with the controls below. The
            current duration and event timezone are preserved.
          </p>
          <Field label="Destination date" required>
            <input
              aria-label="Destination date"
              className="ui-input"
              type="date"
              required
              value={targetDate}
              onChange={(event) => {
                setTargetDate(event.target.value);
              }}
            />
          </Field>
          <Field label="Destination space">
            <Select
              aria-label="Destination space"
              value={targetSpaceId}
              onChange={(event) => {
                setTargetSpaceId(event.target.value);
              }}
            >
              <option value="">Unassigned / location only</option>
              {resources.map((resource) => (
                <option value={resource.id} key={resource.id}>
                  {resource.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Destination start time"
            required
            hint="Time is interpreted in the destination space’s timezone."
          >
            <Select
              aria-label="Destination start time"
              required
              value={targetTime}
              onChange={(event) => {
                setTargetTime(event.target.value);
              }}
            >
              <option value="">Choose a start time</option>
              {currentTimeOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
              {HOURS.map((hour) => (
                <option
                  value={`${String(hour).padStart(2, '0')}:00`}
                  key={hour}
                >
                  {timeLabel(hour)}
                </option>
              ))}
              {targetTime &&
                !HOURS.some(
                  (hour) =>
                    targetTime === `${String(hour).padStart(2, '0')}:00`,
                ) &&
                !currentTimeOptions.some(
                  (option) => option.value === targetTime,
                ) && <option value={targetTime}>{targetTime}</option>}
            </Select>
          </Field>
          <Field
            label="Soft conflict override reason"
            hint="Only used if the server reports an overridable team, coach, or official conflict. Space conflicts cannot be overridden."
          >
            <Input
              aria-label="Soft conflict override reason"
              minLength={10}
              maxLength={500}
              value={overrideReason}
              onChange={(event) => {
                setOverrideReason(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={Boolean(movingId) || !targetTime}>
            {movingId ? 'Moving event…' : 'Move selected event'}
          </Button>
        </form>
      )}
    </section>
  );
}
