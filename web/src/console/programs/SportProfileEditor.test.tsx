import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiPatch } from '../../api/client';

import { SportProfileEditor } from './SportProfileEditor';

vi.mock('../../api/client', () => ({ apiPatch: vi.fn() }));

const apiPatchMock = vi.mocked(apiPatch);

describe('SportProfileEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPatchMock.mockResolvedValue({});
  });

  it('edits a discriminated contest format and saves a new profile version', async () => {
    const soccer = builtInSportTemplatesByKey.get('soccer');
    if (!soccer) throw new Error('Soccer template is missing');
    const onSaved = vi.fn().mockResolvedValue(undefined);

    render(
      <SportProfileEditor
        orgId="00000000-0000-4000-8000-000000000001"
        profile={{
          id: '00000000-0000-4000-8000-000000000002',
          name: 'Soccer',
          version: 3,
          profile: soccer,
          hasResults: true,
        }}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByRole('note').textContent).toContain(
      'creates a new version',
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Profile section' }),
      {
        target: { value: 'contestFormats' },
      },
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Format' }), {
      target: { value: 'head_to_head_sets' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Best Of' }), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledOnce();
    });
    const savedRequest = apiPatchMock.mock.calls[0];
    expect(savedRequest?.[0]).toBe(
      '/sports/orgs/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
    );
    expect(savedRequest?.[1]).toMatchObject({
      expectedVersion: 3,
      profile: {
        contestFormats: [{ format: 'head_to_head_sets', bestOf: 5 }],
      },
    });
    expect(savedRequest?.[2]).toBeDefined();
  });
});
