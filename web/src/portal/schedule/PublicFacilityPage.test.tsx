import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublicFacilityPage } from './PublicFacilityPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public facility page', () => {
  it('loads only the approved public facility layout route when a layout is set', async () => {
    const slug = 'northstar-club';
    const facilityId = '0199a413-a221-7000-8000-000000000003';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            facility: {
              name: 'Northstar Fieldhouse',
              address: { city: 'Madison' },
              timezone: 'America/Chicago',
              parking_notes: null,
              map_url: null,
              layout_image_file_id: '0199a413-a221-7000-8000-000000000004',
            },
            spaces: [],
            events: [],
            closures: [],
            organizationTimezone: 'America/Chicago',
          }),
      }),
    );

    render(<PublicFacilityPage slug={slug} facilityId={facilityId} />);

    const image = await screen.findByRole('img', {
      name: 'Northstar Fieldhouse layout',
    });
    expect(image.getAttribute('src')).toBe(
      `/api/v1/files/public/orgs/${encodeURIComponent(slug)}/facilities/${encodeURIComponent(facilityId)}/layout`,
    );
  });
});
