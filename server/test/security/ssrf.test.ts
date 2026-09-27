import { describe, expect, it, vi } from 'vitest';

import { CheckrBackgroundCheckProvider } from '../../src/integrations/background-check/provider';
import { NominatimGeocoder } from '../../src/integrations/geocoder/geocoder';

describe('server-side request allowlists', () => {
  it.each([
    'http://nominatim.openstreetmap.org',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://attacker.invalid',
  ])('rejects untrusted geocoder endpoint %s before fetch', (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      () =>
        new NominatimGeocoder({
          userAgent: 'Athlentry SSRF test',
          baseUrl,
          fetch: fetcher,
        }),
    ).toThrow('Geocoder host is not allow-listed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'http://api.checkr.com',
    'https://127.0.0.1',
    'https://attacker.invalid',
  ])(
    'rejects untrusted background-check endpoint %s before fetch',
    (baseUrl) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(
        () =>
          new CheckrBackgroundCheckProvider({
            apiKey: 'test-key',
            baseUrl,
            fetch: fetcher,
          }),
      ).toThrow('Checkr host is not allow-listed');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
