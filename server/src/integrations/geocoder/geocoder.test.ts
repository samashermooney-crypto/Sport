import { describe, expect, it } from 'vitest';

import { NominatimGeocoder } from './geocoder';

describe('NominatimGeocoder', () => {
  it('requests only its fixed allow-listed HTTPS host and validates coordinates', async () => {
    let requested = '';
    const geocoder = new NominatimGeocoder({
      userAgent: 'Athlentry/1.0 (+https://example.test/contact)',
      fetch: (input) => {
        requested =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input;
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { lat: '41.88', lon: '-87.63', display_name: 'Chicago' },
              { lat: '999', lon: '0', display_name: 'bad' },
            ]),
            { status: 200 },
          ),
        );
      },
    });
    await expect(geocoder.geocode('Chicago')).resolves.toEqual([
      { latitude: 41.88, longitude: -87.63, label: 'Chicago' },
    ]);
    expect(new URL(requested).hostname).toBe('nominatim.openstreetmap.org');
    expect(geocoder.attribution).toBe('© OpenStreetMap contributors');
  });

  it('requires an allow-listed HTTPS host and rejects personal contact details', async () => {
    expect(
      () =>
        new NominatimGeocoder({
          userAgent: 'Athlentry/1.0',
          baseUrl: 'https://other.example',
        }),
    ).toThrow('allow-listed');
    expect(
      () =>
        new NominatimGeocoder({
          userAgent: 'Athlentry/1.0',
          baseUrl: 'http://nominatim.openstreetmap.org',
        }),
    ).toThrow('allow-listed');
    const geocoder = new NominatimGeocoder({
      userAgent: 'Athlentry/1.0',
      fetch: () => Promise.resolve(new Response('[]')),
    });
    await expect(geocoder.geocode('coach@example.test')).rejects.toThrow(
      'personal contact details',
    );
    await expect(geocoder.geocode('+1 (555) 555-0123')).rejects.toThrow(
      'personal contact details',
    );
  });

  it('caches a successful facility lookup for repeat requests', async () => {
    let calls = 0;
    const geocoder = new NominatimGeocoder({
      userAgent: 'Athlentry/1.0',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('[]'));
      },
    });
    await geocoder.geocode('Riverside Fields');
    await geocoder.geocode('riverside fields');
    expect(calls).toBe(1);
  });
});
