import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformConsole } from './PlatformConsole';

const orgId = '928e838a-464d-43df-aa27-1d5be28d8c45';
const baseOrg = {
  id: orgId,
  slug: 'test-club',
  name: 'Test Club',
  kind: 'club',
  status: 'active',
  version: 1,
  planName: 'Starter',
  createdAt: '2026-09-01T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('platform console', () => {
  it('shows a staff-only organization action and sends a versioned suspension', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: input, method });
        let body: unknown;
        if (input.endsWith('/me'))
          body = {
            accountId: '82e8069b-3477-46a5-aeeb-15bdf0ee71b5',
            role: 'super_admin',
          };
        else if (input.includes('/orgs?'))
          body = { items: [baseOrg], nextCursor: null };
        else if (input.endsWith(`/orgs/${orgId}`))
          body = {
            ...baseOrg,
            planId: null,
            applicationFeeBps: 150,
            applicationFeeFixedCents: 0,
            stripe: null,
          };
        else if (input.endsWith('/plans')) body = { items: [] };
        else if (input.endsWith(`/orgs/${orgId}/status`))
          body = { status: 'suspended', version: 2 };
        else throw new Error(`Unexpected request ${input}`);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        } as Response);
      }),
    );
    render(<PlatformConsole />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test Club' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.url.endsWith(`/orgs/${orgId}/status`) &&
            call.method === 'PATCH',
        ),
      ).toBe(true);
    });
  });

  it('does not show admin controls to support staff', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        const body = input.endsWith('/me')
          ? {
              accountId: '82e8069b-3477-46a5-aeeb-15bdf0ee71b5',
              role: 'support',
            }
          : input.includes('/orgs?')
            ? { items: [], nextCursor: null }
            : { items: [] };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        } as Response);
      }),
    );
    render(<PlatformConsole />);
    await screen.findByRole('heading', { name: 'Organizations' });
    expect(screen.queryByRole('button', { name: 'Plans' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Staff' })).toBeNull();
  });
});
