import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PricingPage } from './PricingPage';

afterEach(() => vi.unstubAllGlobals());

describe('marketing pricing page', () => {
  it('renders current public plan values returned by the plan catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  key: 'pro',
                  name: 'Pro',
                  monthlyPriceCents: 9900,
                  customPricing: false,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/pricing']}>
          <Routes>
            <Route path="/pricing" element={<PricingPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      (await screen.findByRole('heading', { name: 'Pro' })).textContent,
    ).toBe('Pro');
    expect(screen.getByText('$99')).toBeTruthy();
    expect(screen.getByText('/ month')).toBeTruthy();
  });
});
