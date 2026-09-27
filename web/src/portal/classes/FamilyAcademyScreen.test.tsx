import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { FamilyAcademyScreen } from './FamilyAcademyScreen';

vi.mock('../../api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

const orgId = '0199a413-a221-7000-8000-000000000003';
const personId = '0199a413-a221-7000-8000-000000000004';
const programId = '0199a413-a221-7000-8000-000000000005';
const offeringId = '0199a413-a221-7000-8000-000000000006';
const enrollmentId = '0199a413-a221-7000-8000-000000000007';

const enrolledResult = {
  enrollment: {
    id: enrollmentId,
    classOfferingId: offeringId,
    offeringName: 'Beginner Gymnastics',
    personId,
    personName: 'Avery Athlete',
    householdId: '0199a413-a221-7000-8000-000000000008',
    accountId: '0199a413-a221-7000-8000-000000000009',
    status: 'active',
    startsOn: '2026-09-27',
    endsOn: null,
    withdrawEffectiveOn: null,
    pauseFrom: null,
    pauseTo: null,
    classesPerWeek: 1,
    billingSubscriptionId: null,
    version: 1,
    createdAt: '2026-09-27T16:00:00.000Z',
  },
  waitlistEntry: null,
  invoiceId: '0199a413-a221-7000-8000-000000000010',
  amountDueCents: 10_000,
  subscriptionId: null,
};

function payload(path: string): unknown {
  if (path === '/people/me/family')
    return {
      organizations: [
        {
          orgId,
          orgName: 'Northstar Academy',
          people: [
            {
              personId,
              firstName: 'Avery',
              lastName: 'Athlete',
              age: 8,
              relationship: 'guardian',
            },
          ],
        },
      ],
    };
  if (path.includes('/me/browse'))
    return {
      items: [
        {
          classOfferingId: offeringId,
          programId,
          programName: 'Northstar Gymnastics',
          name: 'Beginner Gymnastics',
          description: 'Foundational movement and balance.',
          levelName: 'Beginner',
          billing: 'monthly',
          priceCents: 12_500,
          trialAllowed: true,
          trialPriceCents: 1_000,
          ageMinMonths: 72,
          ageMaxMonths: 144,
          capacity: 8,
          enrolledCount: 1,
          spotsRemaining: 7,
          waitlistCount: 0,
          meetingTimes: [
            {
              weekday: 'MO',
              startTime: '16:00',
              durationMinutes: 60,
              timezone: 'America/Chicago',
              spaceName: 'Studio A',
            },
          ],
          nextSessionAt: '2026-09-28T21:00:00.000Z',
        },
      ],
    };
  if (path.includes('/me/enrollments')) return { items: [], nextCursor: null };
  if (path.includes('/me/makeup-credits')) return { items: [] };
  if (path.includes('/me/waitlist')) return { items: [] };
  if (path.includes('/me/punch-cards')) return { items: [] };
  if (path.includes('/me/promotions')) return { items: [] };
  if (path.includes('/me/subscriptions')) return { items: [] };
  if (path === '/finance/me/payment-methods')
    return { methods: [], defaultMethodId: null };
  if (path.includes('/people/') && path.endsWith('/progress'))
    return {
      personId,
      personName: 'Avery Athlete',
      currentLevelId: null,
      currentLevelName: null,
      levels: [],
    };
  throw new Error(`Unexpected request: ${path}`);
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(payload(path) as never),
  );
  vi.mocked(apiPost).mockImplementation(() =>
    Promise.resolve(enrolledResult as never),
  );
});
afterEach(cleanup);

describe('family academy screen', () => {
  it('shows age-matched classes and submits enrollment through the portal API', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <FamilyAcademyScreen orgId={orgId} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Beginner Gymnastics' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enroll student' }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        `/classes/orgs/${orgId}/me/enrollments`,
        expect.objectContaining({
          classOfferingId: offeringId,
          personId,
          classesPerWeek: 1,
          trial: false,
          autopay: false,
        }),
        expect.anything(),
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );
    });
    expect(
      await screen.findByText(
        'Avery Athlete is enrolled in Beginner Gymnastics.',
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(/An invoice was created for 10000 cents/),
    ).toBeTruthy();
    client.clear();
  });
});
