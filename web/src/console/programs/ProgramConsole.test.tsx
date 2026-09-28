import {
  fireEvent,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { ProgramConsole } from './ProgramConsole';

vi.mock('../../api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

const apiGetMock = vi.mocked(apiGet);
const apiPostMock = vi.mocked(apiPost);
const orgId = '00000000-0000-4000-8000-000000000001';
const seasonId = '00000000-0000-4000-8000-000000000002';
const profileId = '00000000-0000-4000-8000-000000000003';
const programId = '00000000-0000-4000-8000-000000000004';
const offeringId = '00000000-0000-4000-8000-000000000005';
const installmentId = '00000000-0000-4000-8000-000000000006';
const secondOfferingId = '00000000-0000-4000-8000-000000000008';

const program = (status = 'draft') => ({
  id: programId,
  name: 'Volleyball Club',
  slug: 'volleyball-club',
  version: 1,
  status,
  season_id: seasonId,
});

function configureApi(
  templates: { id: string; name: string; active: boolean }[],
) {
  const createdOfferings: { id: string; name: string; version: number }[] = [];
  apiGetMock.mockImplementation((path) => {
    if (path === `/seasons/orgs/${orgId}`)
      return Promise.resolve([
        {
          id: seasonId,
          name: 'Fall 2026',
          version: 1,
          starts_on: '2026-08-01',
          ends_on: '2026-12-01',
          status: 'active',
        },
      ]);
    if (path === `/sports/orgs/${orgId}`)
      return Promise.resolve([
        { id: profileId, name: 'Volleyball', version: 1 },
      ]);
    if (path === '/sports/templates') return Promise.resolve([]);
    if (path === `/offerings/orgs/${orgId}/installment-templates`)
      return Promise.resolve({ templates });
    if (path === `/offerings/orgs/${orgId}/pricing-context`)
      return Promise.resolve({ timezone: 'America/Chicago' });
    if (path === `/programs/orgs/${orgId}`) return Promise.resolve([]);
    if (path === `/offerings/orgs/${orgId}/libraries`)
      return Promise.resolve({ forms: [], waivers: [] });
    if (path === `/programs/orgs/${orgId}/${programId}`)
      return Promise.resolve({
        program: program(),
        divisions: [
          {
            id: '00000000-0000-4000-8000-000000000007',
            name: 'All participants',
            is_default: true,
          },
        ],
        offerings: createdOfferings,
      });
    throw new Error(`Unexpected GET ${path}`);
  });
  apiPostMock.mockImplementation((path, body) => {
    if (path === `/programs/orgs/${orgId}`) return Promise.resolve(program());
    if (path === `/offerings/orgs/${orgId}`) {
      const request = body as { name: string };
      const created = {
        id: createdOfferings.length === 0 ? offeringId : secondOfferingId,
        name: request.name,
        version: 1,
      };
      createdOfferings.push(created);
      return Promise.resolve(created);
    }
    if (path === `/programs/orgs/${orgId}/${programId}/status`)
      return Promise.resolve(program('published'));
    throw new Error(`Unexpected POST ${path}`);
  });
}

describe('ProgramConsole installment picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  const openOfferingsStep = async () => {
    render(<ProgramConsole orgId={orgId} />);
    await screen.findAllByRole('option', { name: 'Fall 2026' });
    const wizardHeading = screen.getByRole('heading', {
      name: 'Create program',
    });
    const wizard = wizardHeading.parentElement;
    if (!wizard) throw new Error('Program wizard section was not rendered');
    fireEvent.change(screen.getByLabelText('Program name'), {
      target: { value: 'Volleyball Club' },
    });
    fireEvent.change(screen.getByLabelText('URL slug'), {
      target: { value: 'volleyball-club' },
    });
    const startsControl = within(wizard).getByLabelText('Starts');
    const endsControl = within(wizard).getByLabelText('Ends');
    if (
      !(startsControl instanceof HTMLInputElement) ||
      !(endsControl instanceof HTMLInputElement)
    )
      throw new Error('Program start and end controls were not rendered');
    const programStarts = startsControl;
    const programEnds = endsControl;
    fireEvent.change(programStarts, {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(programEnds, {
      target: { value: '2026-12-01' },
    });
    expect(programStarts.value).toBe('2026-08-01');
    expect(programEnds.value).toBe('2026-12-01');
    fireEvent.click(within(wizard).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(wizard).getByRole('button', { name: 'Continue' }));
    await within(wizard).findByText(/Offerings and pricing/);
    return wizard;
  };

  it('hides the picker when no installment templates are available', async () => {
    configureApi([]);
    const wizard = await openOfferingsStep();

    expect(within(wizard).queryByText('Installment plan')).toBeNull();
  });

  it('submits the selected template with the offering created by the wizard', async () => {
    configureApi([{ id: installmentId, name: 'Three payments', active: true }]);
    const wizard = await openOfferingsStep();

    const planPicker = within(wizard).getAllByRole('combobox').at(-1);
    if (!planPicker)
      throw new Error('Installment plan picker was not rendered');
    fireEvent.change(planPicker, {
      target: { value: installmentId },
    });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(wizard).getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and publish' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'Volleyball Club is published',
      );
    });
    const offeringRequest = apiPostMock.mock.calls.find(
      ([path]) => path === `/offerings/orgs/${orgId}`,
    );
    expect(offeringRequest?.[1]).toMatchObject({
      programId,
      pricing: { installmentTemplateIds: [installmentId] },
    });
  });

  it('creates two offerings with their selected installment templates', async () => {
    configureApi([
      { id: installmentId, name: 'Three payments', active: true },
      {
        id: '00000000-0000-4000-8000-000000000009',
        name: 'Five payments',
        active: true,
      },
    ]);
    const wizard = await openOfferingsStep();
    fireEvent.change(within(wizard).getByLabelText('Offering 1 name'), {
      target: { value: 'Player registration' },
    });
    const firstInstallmentPicker = within(wizard).getAllByRole('combobox')[0];
    if (!firstInstallmentPicker)
      throw new Error('First installment plan picker was not rendered');
    fireEvent.change(firstInstallmentPicker, {
      target: { value: installmentId },
    });
    fireEvent.click(
      within(wizard).getByRole('button', { name: 'Add offering' }),
    );
    fireEvent.change(within(wizard).getByLabelText('Offering 2 name'), {
      target: { value: 'Goalkeeper registration' },
    });
    const installmentPickers = within(wizard).getAllByRole('combobox');
    const secondInstallmentPicker = installmentPickers[1];
    if (!secondInstallmentPicker)
      throw new Error('Second installment plan picker was not rendered');
    fireEvent.change(secondInstallmentPicker, {
      target: { value: '00000000-0000-4000-8000-000000000009' },
    });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(wizard).getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and publish' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'Volleyball Club is published with 1 divisions and 2 offerings',
      );
    });
    const offeringRequests = apiPostMock.mock.calls.filter(
      ([path]) => path === `/offerings/orgs/${orgId}`,
    );
    expect(offeringRequests).toHaveLength(2);
    expect(offeringRequests[0]?.[1]).toMatchObject({
      name: 'Player registration',
      pricing: { installmentTemplateIds: [installmentId] },
    });
    expect(offeringRequests[1]?.[1]).toMatchObject({
      name: 'Goalkeeper registration',
      pricing: {
        installmentTemplateIds: ['00000000-0000-4000-8000-000000000009'],
      },
    });
  });
});
