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
const originalOnlineDescriptor = Object.getOwnPropertyDescriptor(
  window.navigator,
  'onLine',
);
const originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);
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
  if (originalOnlineDescriptor)
    Object.defineProperty(window.navigator, 'onLine', originalOnlineDescriptor);
  if (originalScrollIntoViewDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScrollIntoViewDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
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

  it('syncs scores added while an earlier score request is still in flight', async () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    const secondAthleteId = randomUUID();
    const secondPersonId = randomUUID();
    const twoAthleteSheet = {
      ...sheet,
      participants: [
        ...sheet.participants,
        {
          id: secondAthleteId,
          personId: secondPersonId,
          bibNumber: 15,
          groupId: randomUUID(),
          groupName: 'U10',
          positionKeys: ['keeper'],
          checkInStatus: 'checked_in',
          firstName: 'Jordan',
          lastName: 'Athlete',
          photoFileId: null,
        },
      ],
    };
    const scoreRequests: Array<{ body: Record<string, unknown> }> = [];
    let resolveFirstRequest!: (response: Response) => void;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const scoreResponse = (body: Record<string, unknown>) =>
      ({
        ok: true,
        json: () =>
          Promise.resolve({
            id: randomUUID(),
            participantId: body.participantId,
            criterionId: body.criterionId,
            version: 1,
            clientMutationId: body.clientMutationId,
          }),
      }) as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path =
          input instanceof Request
            ? input.url
            : typeof input === 'string'
              ? input
              : input.href;
        if (path.endsWith('/scoring-sheet'))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(twoAthleteSheet),
          } as Response);
        const body =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
        scoreRequests.push({ body });
        return scoreRequests.length === 1
          ? firstRequest
          : Promise.resolve(scoreResponse(body));
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
    const sliders = await screen.findAllByRole('slider');
    const firstAthleteHeader = screen.getByRole('heading', {
      name: 'Alex Athlete',
    }).parentElement?.parentElement;
    if (!firstAthleteHeader) throw new Error('Athlete header is missing');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.pointerDown(firstAthleteHeader, {
      clientX: 150,
      clientY: 100,
      pointerId: 1,
      pointerType: 'touch',
    });
    fireEvent.pointerUp(firstAthleteHeader, {
      clientX: 70,
      clientY: 104,
      pointerId: 1,
      pointerType: 'touch',
    });
    await waitFor(() => {
      expect(screen.getByText('Athlete 2 of 2')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Previous athlete' }));
    await waitFor(() => {
      expect(screen.getByText('Athlete 1 of 2')).toBeDefined();
    });
    fireEvent.change(sliders[0] as HTMLElement, { target: { value: '3' } });
    await waitFor(() => {
      expect(scoreRequests).toHaveLength(1);
    });
    fireEvent.change(sliders[1] as HTMLElement, { target: { value: '4' } });
    await waitFor(() => {
      expect(screen.getByText('2 unsynced scores')).toBeDefined();
    });

    resolveFirstRequest(scoreResponse(scoreRequests[0]?.body ?? {}));
    await waitFor(() => {
      expect(scoreRequests).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByText('0 unsynced scores')).toBeDefined();
    });
    expect(scoreRequests.map((request) => request.body.participantId)).toEqual([
      participantId,
      secondAthleteId,
    ]);
    expect(
      new Set(scoreRequests.map((request) => request.body.clientMutationId))
        .size,
    ).toBe(2);
  });
});
