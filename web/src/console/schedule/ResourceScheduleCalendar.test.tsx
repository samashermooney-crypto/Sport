import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ResourceScheduleCalendar,
  type ResourceMoveHandler,
} from './ResourceScheduleCalendar';

afterEach(cleanup);

const event = {
  id: 'event-1',
  title: 'Home match',
  startsAt: '2026-09-27T14:00:00.000Z',
  endsAt: '2026-09-27T15:00:00.000Z',
  timezone: 'America/Chicago',
  status: 'scheduled',
  version: 4,
  spaceId: 'court-a',
};

const resources = [
  { id: 'court-a', name: 'Court A' },
  { id: 'court-b', name: 'Court B' },
];

function renderCalendar(onMove: ResourceMoveHandler) {
  return render(
    <ResourceScheduleCalendar
      events={[event]}
      resources={resources}
      timezone="America/Chicago"
      initialDate="2026-09-27"
      onMove={onMove}
    />,
  );
}

describe('resource schedule calendar', () => {
  it('moves a selected event through keyboard controls and preserves duration', async () => {
    const onMove = vi.fn<ResourceMoveHandler>(() => Promise.resolve());
    renderCalendar(onMove);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Select Home match, 9:00 AM to 10:00 AM',
      }),
    );
    fireEvent.change(screen.getByLabelText('Destination space'), {
      target: { value: 'court-b' },
    });
    fireEvent.change(screen.getByLabelText('Destination start time'), {
      target: { value: '10:00' },
    });
    fireEvent.change(screen.getByLabelText('Soft conflict override reason'), {
      target: { value: 'Balance travel for the visiting team' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Move selected event' }),
    );

    await waitFor(() => {
      expect(onMove).toHaveBeenCalledTimes(1);
    });
    expect(onMove).toHaveBeenCalledWith(event, {
      startsAt: '2026-09-27T15:00:00Z',
      endsAt: '2026-09-27T16:00:00Z',
      spaceId: 'court-b',
      timezone: 'America/Chicago',
      overrideReason: 'Balance travel for the visiting team',
    });
  });

  it('moves a scheduled event when dropped into a resource time cell', async () => {
    const onMove = vi.fn<ResourceMoveHandler>(() => Promise.resolve());
    renderCalendar(onMove);
    let draggedId = '';
    const dataTransfer = {
      effectAllowed: 'all',
      setData: (_type: string, value: string) => {
        draggedId = value;
      },
      getData: () => draggedId,
    };

    fireEvent.dragStart(
      screen.getByRole('button', {
        name: 'Select Home match, 9:00 AM to 10:00 AM',
      }),
      { dataTransfer },
    );
    fireEvent.dragOver(screen.getByRole('cell', { name: 'Court B, 11 AM' }), {
      dataTransfer,
    });
    fireEvent.drop(screen.getByRole('cell', { name: 'Court B, 11 AM' }), {
      dataTransfer,
    });

    await waitFor(() => {
      expect(onMove).toHaveBeenCalledTimes(1);
    });
    expect(onMove).toHaveBeenCalledWith(event, {
      startsAt: '2026-09-27T16:00:00Z',
      endsAt: '2026-09-27T17:00:00Z',
      spaceId: 'court-b',
      timezone: 'America/Chicago',
    });
  });

  it('interprets the destination slot in the destination facility timezone', async () => {
    const onMove = vi.fn<ResourceMoveHandler>(() => Promise.resolve());
    render(
      <ResourceScheduleCalendar
        events={[event]}
        resources={[
          { id: 'court-a', name: 'Court A' },
          {
            id: 'court-b',
            name: 'Court B',
            timezone: 'America/Phoenix',
          },
        ]}
        timezone="America/Chicago"
        initialDate="2026-09-27"
        onMove={onMove}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Select Home match, 9:00 AM to 10:00 AM',
      }),
    );
    fireEvent.change(screen.getByLabelText('Destination space'), {
      target: { value: 'court-b' },
    });
    fireEvent.change(screen.getByLabelText('Destination start time'), {
      target: { value: '11:00' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Move selected event' }),
    );

    await waitFor(() => {
      expect(onMove).toHaveBeenCalledTimes(1);
    });
    expect(onMove).toHaveBeenCalledWith(event, {
      startsAt: '2026-09-27T18:00:00Z',
      endsAt: '2026-09-27T19:00:00Z',
      spaceId: 'court-b',
      timezone: 'America/Phoenix',
    });
  });
});
