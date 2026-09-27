import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Calendar } from './extended';
import { DataTable, Switch, Tabs } from './primitives';

describe('shared design system interactions', () => {
  it('changes tabs and supports sorting and row selection', () => {
    const onTabChange = vi.fn();
    const onSelectionChange = vi.fn();
    const rows = [
      { id: '2', name: 'Volleyball' },
      { id: '1', name: 'Baseball' },
    ];
    const { container } = render(
      <>
        <Tabs
          items={['Overview', 'Details']}
          value="Overview"
          onChange={onTabChange}
        />
        <DataTable
          rows={rows}
          columns={[{ key: 'name', label: 'Program', sort: (row) => row.name }]}
          selectable
          selected={[]}
          onSelectionChange={onSelectionChange}
        />
      </>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(onTabChange).toHaveBeenCalledWith('Details');
    fireEvent.click(screen.getByRole('button', { name: /Program/ }));
    const tableRows = container.querySelectorAll(
      '.ui-data-table tbody > tr:not(.ui-mobile-row)',
    );
    expect(tableRows[0]?.textContent).toContain('Baseball');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['2', '1']);
  });

  it('preserves uncontrolled switch state when no checked value is provided', () => {
    render(<Switch label="Schedule alerts" defaultChecked />);
    const control = screen.getByRole('switch', { name: 'Schedule alerts' });
    expect((control as HTMLInputElement).checked).toBe(true);
    fireEvent.click(control);
    expect((control as HTMLInputElement).checked).toBe(false);
  });

  it('changes calendar views without requiring an owner callback', () => {
    const eventDate = new Date().toISOString().slice(0, 10);
    const { container } = render(
      <Calendar
        initialDate={eventDate}
        events={[
          {
            id: 'event-1',
            title: 'Opening day',
            date: eventDate,
          },
        ]}
      />,
    );
    const calendar = container.querySelector<HTMLElement>('.ui-calendar');
    expect(calendar).not.toBeNull();
    if (!calendar) throw new Error('Calendar missing');
    fireEvent.click(within(calendar).getByRole('button', { name: 'week' }));
    expect(calendar.querySelectorAll('[role="gridcell"]')).toHaveLength(7);
    expect(within(calendar).getByText('Opening day')).toBeTruthy();
  });
});
