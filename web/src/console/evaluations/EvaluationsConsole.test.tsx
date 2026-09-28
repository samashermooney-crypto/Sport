import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost, apiPut } from '../../api/client';

import { EvaluationList } from './EvaluationsConsole';

vi.mock('../../api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

const orgId = '11111111-1111-4111-8111-111111111111';
const programId = '22222222-2222-4222-8222-222222222222';
const divisionId = '33333333-3333-4333-8333-333333333333';
const boardId = '44444444-4444-4444-8444-444444444444';
const teamOneId = '55555555-5555-4555-8555-555555555555';
const teamTwoId = '66666666-6666-4666-8666-666666666666';
const firstPersonId = '77777777-7777-4777-8777-777777777777';
const secondPersonId = '88888888-8888-4888-8888-888888888888';

const placements = [
  {
    id: '99999999-9999-4999-8999-999999999999',
    personId: firstPersonId,
    firstName: 'Alex',
    lastName: 'Athlete',
    teamSeasonId: teamOneId,
    teamName: 'Blue',
    rating: 4,
    locked: false,
    status: 'placed',
    version: 3,
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    personId: secondPersonId,
    firstName: 'Jordan',
    lastName: 'Player',
    teamSeasonId: teamTwoId,
    teamName: 'Gold',
    rating: 3,
    locked: false,
    status: 'placed',
    version: 5,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path.endsWith('/workspace'))
      return Promise.resolve({ name: 'North Club' });
    if (path.endsWith('/programs'))
      return Promise.resolve([
        {
          id: programId,
          name: 'U10 League',
          mode: 'league',
          sportProfileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
          sportProfileName: 'Soccer',
          rubric: [],
          divisions: [{ id: divisionId, name: 'U10' }],
          offerings: [],
        },
      ]);
    if (path.endsWith('/events')) return Promise.resolve([]);
    if (path.endsWith(`/programs/${programId}/placement-preferences`))
      return Promise.resolve([
        {
          personId: firstPersonId,
          firstName: 'Alex',
          lastName: 'Athlete',
          friendRequestPersonId: null,
          practiceLocation: null,
          coachRating: null,
          note: null,
          source: 'staff',
          version: 1,
        },
        {
          personId: secondPersonId,
          firstName: 'Jordan',
          lastName: 'Player',
          friendRequestPersonId: null,
          practiceLocation: null,
          coachRating: null,
          note: null,
          source: 'staff',
          version: 1,
        },
      ]);
    if (path.endsWith(`/boards/${boardId}`))
      return Promise.resolve({
        id: boardId,
        status: 'draft',
        metrics: [],
        placements,
      });
    if (path.endsWith(`/boards/${boardId}/offers`))
      return Promise.resolve({
        boardId,
        status: 'draft',
        teams: [
          {
            teamSeasonId: teamOneId,
            teamName: 'Blue',
            rosterLimit: 12,
            sent: 0,
            accepted: 0,
            declined: 0,
            expired: 0,
            withdrawn: 0,
            placed: 1,
          },
          {
            teamSeasonId: teamTwoId,
            teamName: 'Gold',
            rosterLimit: 12,
            sent: 0,
            accepted: 0,
            declined: 0,
            expired: 0,
            withdrawn: 0,
            placed: 1,
          },
        ],
        nextInLine: [],
      });
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(apiPost).mockImplementation((path) => {
    if (path.endsWith(`/programs/${programId}/boards`))
      return Promise.resolve({
        id: boardId,
        targetProgramId: programId,
        divisionId,
        seed: 1,
        assignments: {},
        metrics: [],
        objective: 0,
      });
    return Promise.resolve({ id: boardId, status: 'draft' });
  });
  vi.mocked(apiPut).mockResolvedValue({ id: firstPersonId, status: 'draft' });
});

afterEach(cleanup);

it('moves an unlocked rec player by dropping them onto a teammate', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/console/orgs/${orgId}/evaluations`]}>
        <Routes>
          <Route
            path="/console/orgs/:orgId/evaluations"
            element={<EvaluationList />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await screen.findByRole('option', { name: 'U10 League' });
  fireEvent.change(screen.getByLabelText(/League program/), {
    target: { value: programId },
  });
  await screen.findByRole('option', { name: 'U10' });
  fireEvent.change(screen.getByLabelText(/Division/), {
    target: { value: divisionId },
  });
  const rating = await screen.findByLabelText('Coach rating for Alex Athlete');
  fireEvent.change(rating, { target: { value: '5' } });
  const ratingRow = rating.closest('[role="group"]');
  expect(ratingRow).toBeTruthy();
  fireEvent.click(
    within(ratingRow as HTMLElement).getByRole('button', {
      name: 'Save rating',
    }),
  );
  await waitFor(() => {
    expect(apiPut).toHaveBeenCalledWith(
      `/evaluations/orgs/${orgId}/programs/${programId}/placement-preferences`,
      {
        personId: firstPersonId,
        friendRequestPersonId: null,
        practiceLocation: null,
        coachRating: 5,
        note: null,
        source: 'staff',
      },
      expect.anything(),
    );
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Build rec-league board' }),
  );

  const sourceText = await screen.findByText('Alex Athlete → Blue');
  const targetText = screen.getByText('Jordan Player → Gold');
  const source = sourceText.closest('.evaluation-placement');
  const target = targetText.closest('.evaluation-placement');
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  const transfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: vi.fn(() => firstPersonId),
  };
  fireEvent.dragStart(source as Element, { dataTransfer: transfer });
  fireEvent.drop(target as Element, { dataTransfer: transfer });

  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/evaluations/orgs/${orgId}/boards/${boardId}/placements/move`,
      {
        personId: firstPersonId,
        teamSeasonId: teamTwoId,
        expectedVersion: 3,
      },
      expect.anything(),
    );
  });
});
