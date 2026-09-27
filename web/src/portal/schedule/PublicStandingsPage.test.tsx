import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublicStandingsPage } from './PublicStandingsPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('public standings page', () => {
  it('shows named standings and opens the browser print dialog', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          rows: [
            {
              teamId: 'team-season-1',
              rank: 1,
              played: 4,
              wins: 3,
              losses: 1,
              ties: 0,
              scored: 12,
              allowed: 5,
              differential: 7,
              points: 9,
            },
          ],
          teamNames: { 'team-season-1': 'Northside Comets' },
          computed_at: '2026-09-27T12:00:00.000Z',
        }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const print = vi.fn();
    Object.defineProperty(window, 'print', {
      configurable: true,
      value: print,
    });

    render(
      <PublicStandingsPage
        slug="northside"
        scopeType="program"
        scopeId="program-1"
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Program standings' }),
    ).toBeTruthy();
    expect(screen.getByRole('row', { name: /Northside Comets/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/standings/public/orgs/northside/programs/program-1',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Print standings / Save PDF' }),
    );
    expect(print).toHaveBeenCalledOnce();
  });

  it('shows the API denial when standings are not public', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: 'Standings are not public.' }),
      } as Response),
    );

    render(
      <PublicStandingsPage
        slug="northside"
        scopeType="division"
        scopeId="division-1"
      />,
    );

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Standings are not public.',
    );
  });
});
