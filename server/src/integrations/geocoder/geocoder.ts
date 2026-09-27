import { z } from 'zod';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  label: string;
}
export interface Geocoder {
  readonly attribution?: string;
  geocode(address: string): Promise<GeocodeResult[]>;
}
const responseSchema = z.array(
  z.object({ lat: z.string(), lon: z.string(), display_name: z.string() }),
);
export class NoopGeocoder implements Geocoder {
  geocode() {
    return Promise.resolve([]);
  }
}

/** Optional Nominatim-compatible lookup. Hosts must be explicitly allow-listed. */
export class NominatimGeocoder implements Geocoder {
  readonly attribution = '© OpenStreetMap contributors';
  private static requestQueue: Promise<void> = Promise.resolve();
  private static lastRequestStartedAt = 0;
  private readonly endpoint: URL;
  private readonly cache = new Map<
    string,
    { until: number; results: GeocodeResult[] }
  >();

  constructor(
    private readonly options: {
      userAgent: string;
      baseUrl?: string;
      allowedHosts?: string[];
      fetch?: typeof fetch;
    },
  ) {
    if (!options.userAgent || options.userAgent.length < 8)
      throw new Error('A descriptive geocoder User-Agent is required');
    this.endpoint = new URL(
      options.baseUrl ?? 'https://nominatim.openstreetmap.org',
    );
    const allowedHosts = options.allowedHosts ?? [
      'nominatim.openstreetmap.org',
    ];
    if (
      this.endpoint.protocol !== 'https:' ||
      !allowedHosts.includes(this.endpoint.hostname)
    )
      throw new Error('Geocoder host is not allow-listed');
  }

  async geocode(address: string): Promise<GeocodeResult[]> {
    const query = address.trim();
    if (!query || query.length > 300) return [];
    if (
      /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(query) ||
      /(?:\+?\d[\d .()-]{8,}\d)/.test(query)
    ) {
      throw new Error(
        'Geocoder accepts facility addresses only; personal contact details are not sent',
      );
    }
    const cacheKey = query.toLocaleLowerCase('en-US');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.results;
    const url = new URL('/search', this.endpoint);
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '5',
    }).toString();
    const fetcher = this.options.fetch ?? fetch;
    const response = await this.enqueue(() =>
      fetcher(url, {
        headers: {
          'user-agent': this.options.userAgent,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      }),
    );
    if (!response.ok)
      throw new Error(
        `Geocoder request failed with HTTP ${String(response.status)}`,
      );
    const results = responseSchema
      .parse(await response.json())
      .map((item) => ({
        latitude: Number(item.lat),
        longitude: Number(item.lon),
        label: item.display_name,
      }))
      .filter(
        (item) =>
          Number.isFinite(item.latitude) &&
          Number.isFinite(item.longitude) &&
          Math.abs(item.latitude) <= 90 &&
          Math.abs(item.longitude) <= 180,
      );
    this.cache.set(cacheKey, {
      until: Date.now() + 24 * 60 * 60 * 1000,
      results,
    });
    return results;
  }

  private enqueue<T>(request: () => Promise<T>): Promise<T> {
    const current = NominatimGeocoder.requestQueue.then(async () => {
      const waitMs = Math.max(
        0,
        1000 - (Date.now() - NominatimGeocoder.lastRequestStartedAt),
      );
      if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      NominatimGeocoder.lastRequestStartedAt = Date.now();
      return request();
    });
    NominatimGeocoder.requestQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
