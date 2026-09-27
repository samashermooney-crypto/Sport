import { randomUUID } from 'node:crypto';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvaluationScoringSheet } from './EvaluationPortal';

const orgId = randomUUID();
const eventId = randomUUID();
const participantId = randomUUID();
const personId = randomUUID();
const criterionId = randomUUID();
const sheet = {
  event: {
    id: eventId,
    name: 'U10 tryout',
    normalization: 'z_score_per_evaluator',
    status: 'live',
  },
  participants: [
    {
      id: participantId,
      personId,
      bibNumber: 14,
      groupId: randomUUID(),
      groupName: 'U10',
      positionKeys: ['keeper'],
      checkInStatus: 'checked_in',
      firstName: 'Alex',
      lastName: 'Athlete',
      photoFileId: null,
    },
  ],
  criteria: [
    {
      id: criterionId,
      key: 'footwork',
      label: 'Footwork',
      weight: 1,
      scaleMin: 1,
      scaleMax: 5,
      positionSpecific: false,
      positionKeys: [],
    },
  ],
  scores: [],
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('evaluation scoring sheet', () => {
  it('queues scoring while offline and syncs the saved row once after reconnect', async () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path =
          input instanceof Request
            ? input.url
            : typeof input === 'string'
              ? input
              : input.href;
        const body =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
        requests.push({ path, body });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              path.endsWith('/scoring-sheet')
                ? sheet
                : {
                    id: randomUUID(),
                    participantId,
                    criterionId,
                    version: 1,
                    clientMutationId: body.clientMutationId,
                  },
            ),
        } as Response);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            `/portal/orgs/${orgId}/evaluations/${eventId}/score`,
          ]}
        >
          <Routes>
            <Route
              path="/portal/orgs/:orgId/evaluations/:eventId/score"
              element={<EvaluationScoringSheet />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'U10 tryout' }),
    ).toBeDefined();
    expect(screen.getByText('Offline')).toBeDefined();
    fireEvent.change(screen.getByRole('slider', { name: 'Footwork' }), {
      target: { value: '3' },
    });
    await waitFor(() => {
      expect(screen.getByText('1 unsynced scores')).toBeDefined();
    });
    expect(
      requests.filter((request) => request.path.endsWith('/scores')),
    ).toHaveLength(0);

    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event('online'));
    await waitFor(() => {
      expect(screen.getByText('0 unsynced scores')).toBeDefined();
    });
    const scoreRequests = requests.filter((request) =>
      request.path.endsWith('/scores'),
    );
    expect(scoreRequests).toHaveLength(1);
    expect(scoreRequests[0]?.body).toMatchObject({
      participantId,
      criterionId,
      score: 3,
    });
  });
});
