import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext, Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

describe('installable app shell assets', () => {
  it('keeps the manifest, icon, theme tokens, and service worker in sync', async () => {
    const root = process.cwd();
    const manifest = JSON.parse(
      await readFile(resolve(root, 'public/manifest.webmanifest'), 'utf8'),
    ) as {
      background_color: string;
      display: string;
      icons: { src: string; type: string; purpose: string }[];
      name: string;
      theme_color: string;
    };
    const [index, tokens, icon, worker] = await Promise.all([
      readFile(resolve(root, 'web/index.html'), 'utf8'),
      readFile(resolve(root, 'web/src/ui/tokens.css'), 'utf8'),
      readFile(resolve(root, 'public/athlentry-icon.svg'), 'utf8'),
      readFile(resolve(root, 'public/sw.js'), 'utf8'),
    ]);

    expect(manifest).toMatchObject({
      background_color: '#f4f6f8',
      display: 'standalone',
      name: 'Athlentry',
      theme_color: '#2e3034',
    });
    expect(index).toContain('href="/manifest.webmanifest"');
    expect(tokens).toContain(`--head: ${manifest.background_color};`);
    expect(tokens).toContain(`--chrome: ${manifest.theme_color};`);
    expect(manifest.icons).toContainEqual({
      purpose: 'any maskable',
      sizes: 'any',
      src: '/athlentry-icon.svg',
      type: 'image/svg+xml',
    });
    expect(index).toContain('href="/athlentry-icon.svg"');
    expect(icon).toContain('viewBox="0 0 512 512"');
    expect(() => new Script(worker)).not.toThrow();
  });

  it('serves the cached SPA shell offline without intercepting API or site routes', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'public/sw.js'),
      'utf8',
    );
    const origin = 'https://athlentry.example';
    type RequestLike = { method: string; mode: string; url: string };
    type WorkerEvent = {
      request?: RequestLike;
      respondWith?: (response: Promise<Response>) => void;
      waitUntil?: (promise: Promise<unknown>) => void;
    };
    const listeners = new Map<string, (event: WorkerEvent) => void>();
    const cacheEntries = new Map<string, Response>();
    class BasicResponse extends Response {
      override get type(): ResponseType {
        return 'basic';
      }
    }
    const key = (request: string | RequestLike): string =>
      new URL(typeof request === 'string' ? request : request.url, origin).href;
    let online = true;
    let networkRequests = 0;
    const fetchAsset = (request: string | RequestLike): Promise<Response> => {
      networkRequests += 1;
      if (!online) return Promise.reject(new Error('offline'));
      const path = new URL(key(request)).pathname;
      const contentType =
        path === '/' ? 'text/html' : 'application/octet-stream';
      return Promise.resolve(
        new BasicResponse(path === '/' ? 'cached app shell' : path, {
          headers: { 'content-type': contentType },
        }),
      );
    };
    const cache = {
      addAll: async (urls: string[]) => {
        for (const url of urls)
          cacheEntries.set(key(url), await fetchAsset(url));
      },
      match: (request: string | RequestLike) =>
        Promise.resolve(cacheEntries.get(key(request))?.clone()),
      put: (request: string | RequestLike, response: Response) => {
        cacheEntries.set(key(request), response.clone());
        return Promise.resolve();
      },
    };
    const self = {
      location: { hostname: 'athlentry.example', origin },
      addEventListener: (
        type: string,
        listener: (event: WorkerEvent) => void,
      ) => {
        listeners.set(type, listener);
      },
      clients: { claim: () => Promise.resolve() },
      registration: { showNotification: () => Promise.resolve() },
      skipWaiting: () => Promise.resolve(),
    };
    const caches = {
      delete: () => Promise.resolve(true),
      keys: () => Promise.resolve(['athlentry-app-shell-v1']),
      open: () => Promise.resolve(cache),
    };
    runInNewContext(source, {
      caches,
      fetch: fetchAsset,
      Response: BasicResponse,
      self,
      URL,
    });

    let installPromise: Promise<unknown> | undefined;
    listeners.get('install')?.({
      waitUntil: (promise) => {
        installPromise = promise;
      },
    });
    await installPromise;

    online = false;
    let offlineNavigation: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: {
        method: 'GET',
        mode: 'navigate',
        url: `${origin}/console/orgs/example`,
      },
      respondWith: (response) => {
        offlineNavigation = response;
      },
    });
    if (!offlineNavigation) throw new Error('Navigation was not intercepted.');
    expect(await (await offlineNavigation).text()).toBe('cached app shell');

    let intercepted = false;
    for (const path of ['/api/v1/auth/status', '/site/club']) {
      listeners.get('fetch')?.({
        request: { method: 'GET', mode: 'navigate', url: `${origin}${path}` },
        respondWith: () => {
          intercepted = true;
        },
      });
    }
    expect(intercepted).toBe(false);

    online = true;
    let cachedAsset: Promise<Response> | undefined;
    const assetRequest = {
      method: 'GET',
      mode: 'cors',
      url: `${origin}/assets/app-abc.js`,
    };
    listeners.get('fetch')?.({
      request: assetRequest,
      respondWith: (response) => {
        cachedAsset = response;
      },
    });
    if (!cachedAsset) throw new Error('Build asset was not intercepted.');
    expect((await cachedAsset).status).toBe(200);
    const requestsAfterCache = networkRequests;
    online = false;
    let offlineAsset: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: assetRequest,
      respondWith: (response) => {
        offlineAsset = response;
      },
    });
    if (!offlineAsset) throw new Error('Offline asset was not intercepted.');
    expect((await offlineAsset).status).toBe(200);
    expect(networkRequests).toBe(requestsAfterCache);
  });
});
