import type { WebsiteMenu, WebsiteSettings } from '@shared/schemas/website';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { WebsiteSettingsConsole } from './WebsiteSettingsConsole';

const orgId = '11111111-1111-4111-8111-111111111111';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : '';
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves website publication settings and a safe navigation menu', async () => {
  let settings: WebsiteSettings = {
    version: 1,
    published: false,
    robotsPolicy: 'index',
    theme: { primary: '#3a67b2', secondary: '#252b2e' },
    seo: { title: '', description: '', canonicalPath: '' },
    contactInboxEmail: null,
  };
  let headerMenu: WebsiteMenu = { location: 'header', items: [], version: 0 };
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      let result: unknown;
      if (url.endsWith('/workspace')) {
        result = {
          id: orgId,
          name: 'Northstar Youth Sports',
          slug: 'northstar',
          canManage: true,
          canAudit: true,
        };
      } else if (url.endsWith('/settings') && method === 'GET') {
        result = { settings };
      } else if (url.endsWith('/menus') && method === 'GET') {
        result = {
          items: [headerMenu, { location: 'footer', items: [], version: 0 }],
        };
      } else if (url.endsWith('/settings') && method === 'PUT') {
        const body = JSON.parse(requestBody(init?.body)) as Omit<
          WebsiteSettings,
          'version'
        > & { expectedVersion: number };
        settings = {
          version: settings.version + 1,
          published: body.published,
          robotsPolicy: body.robotsPolicy,
          theme: body.theme,
          seo: body.seo,
          contactInboxEmail: body.contactInboxEmail,
        };
        result = { settings };
      } else if (url.endsWith('/menus') && method === 'PUT') {
        const body = JSON.parse(requestBody(init?.body)) as {
          location: WebsiteMenu['location'];
          items: { label: string; href: string }[];
        };
        headerMenu = {
          location: body.location,
          items: body.items,
          version: headerMenu.version + 1,
        };
        result = { menu: headerMenu };
      } else {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WebsiteSettingsConsole orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Website settings' }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Primary color/), {
    target: { value: '#123456' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Save website settings' }),
  );
  await waitFor(() => {
    expect(
      fetcher.mock.calls.some(
        ([input, init]) =>
          requestUrl(input).endsWith('/settings') &&
          init?.method === 'PUT' &&
          requestBody(init.body).includes('"primary":"#123456"'),
      ),
    ).toBe(true);
  });

  const addHeaderLinkButton = screen.getAllByRole('button', {
    name: 'Add link',
  })[0];
  if (!addHeaderLinkButton) throw new Error('Header menu add button not found');
  fireEvent.click(addHeaderLinkButton);
  fireEvent.change(screen.getByLabelText(/Link 1 label/), {
    target: { value: 'Schedule' },
  });
  fireEvent.change(screen.getByLabelText(/Link 1 address/), {
    target: { value: '/site/northstar/schedule' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save header menu' }));
  await waitFor(() => {
    const menuSave = fetcher.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith('/menus') && init?.method === 'PUT',
    );
    expect(menuSave).toBeTruthy();
    expect(requestBody(menuSave?.[1]?.body)).toContain('"label":"Schedule"');
    expect(requestBody(menuSave?.[1]?.body)).toContain(
      '"href":"/site/northstar/schedule"',
    );
  });
});
