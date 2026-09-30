import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SafetySettings } from './ConsoleSafety';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderWith(options: { manual: boolean; checkr: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settings: null, options }),
    }),
  );
  render(
    <MemoryRouter initialEntries={['/console/orgs/org-1/safety/settings']}>
      <Routes>
        <Route
          path="/console/orgs/:orgId/safety/settings"
          element={<SafetySettings />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('background check provider choice', () => {
  it('offers only manual review when no provider is configured', async () => {
    renderWith({ manual: true, checkr: false });
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: 'Manual review' }),
      ).toBeDefined();
    });
    expect(screen.queryByRole('option', { name: /Checkr/ })).toBeNull();
  });

  it('offers the configured provider when available', async () => {
    renderWith({ manual: true, checkr: true });
    await waitFor(() => {
      expect(
        screen.getByRole('option', {
          name: 'Checkr staging or configured provider',
        }),
      ).toBeDefined();
    });
  });
});
