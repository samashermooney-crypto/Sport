import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet } from '../api/client';

import { ConsoleHome } from './Home';

vi.mock('../api/client', () => ({
  apiGet: vi.fn(),
}));

const orgId = '0199a413-a221-7000-8000-000000000003';

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path === `/orgs/${orgId}/workspace`)
      return Promise.resolve({
        id: orgId,
        name: 'Northstar Club',
        slug: 'northstar-club',
        canManage: true,
        canAudit: true,
      } as never);
    if (path === '/orgs/mine')
      return Promise.resolve([
        { id: orgId, name: 'Northstar Club', slug: 'northstar-club' },
      ] as never);
    if (path === `/federation/organizations/${orgId}/capabilities`)
      return Promise.resolve({
        relationships: true,
        manageRelationships: true,
        directory: true,
        submitEntries: true,
        schedule: true,
        discipline: true,
        referees: true,
        finance: true,
      } as never);
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(cleanup);

describe('organization console home', () => {
  it('makes the organization schedule reachable from the management home', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/console/orgs/${orgId}`]}>
          <Routes>
            <Route path="/console/orgs/:orgId" element={<ConsoleHome />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const scheduleLink = await screen.findByRole('link', {
      name: 'Manage schedule',
    });
    expect(scheduleLink.getAttribute('href')).toBe(
      `/console/orgs/${orgId}/schedule`,
    );
    const federationLink = await screen.findByRole('link', {
      name: 'Open federation',
    });
    expect(federationLink.getAttribute('href')).toBe(
      `/console/federation/${orgId}`,
    );
    expect(
      screen.getAllByRole('link', { name: 'Open safety center' }),
    ).toHaveLength(1);
    client.clear();
  });
});
