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

import { HelpCenter } from './HelpCenter';

vi.mock('./ai-enabled', () => ({ aiFeaturesEnabled: false }));

const orgId = '0199a413-a221-7000-8000-000000000011';
const article = {
  slug: 'getting-started',
  locale: 'en',
  title: 'Getting started',
  summary: 'A short guide to setting up an organization.',
  category: 'Organization setup',
  audience: 'admin',
};
const catalog = {
  articles: [article],
  categories: ['Organization setup'],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderHelpCenter(initialEntry = `/console/orgs/${orgId}/help`): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <HelpCenter orgId={orgId} audience="admin" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('announces while help articles load and keeps support available', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );

  renderHelpCenter();

  expect(screen.getByRole('status').textContent).toContain(
    'Loading help articles…',
  );
  expect(screen.getByRole('heading', { name: 'Contact support' })).toBeTruthy();
});

it('shows and retries catalog and search errors without hiding support', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ message: 'Unavailable' }, 503))
    .mockResolvedValueOnce(jsonResponse(catalog))
    .mockResolvedValueOnce(jsonResponse({ message: 'Unavailable' }, 503))
    .mockResolvedValueOnce(jsonResponse({ results: [article] }));
  vi.stubGlobal('fetch', fetchMock);

  renderHelpCenter();

  const catalogError = await screen.findByRole('alert');
  expect(catalogError.textContent).toContain(
    'Help articles are unavailable right now.',
  );
  expect(screen.getByRole('heading', { name: 'Contact support' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(
    await screen.findByRole('button', { name: 'Getting started' }),
  ).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'setup' },
  });
  const searchError = await screen.findByRole('alert');
  expect(searchError.textContent).toContain(
    'Help search is unavailable right now.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
  expect(
    await screen.findByRole('button', { name: 'Getting started' }),
  ).toBeTruthy();
});

it('opens localized contextual articles and carries import context into support', async () => {
  const contextualArticle = {
    ...article,
    slug: 'importing-data',
    locale: 'es',
    title: 'Importar datos',
    summary: 'Prepare a safe import.',
    category: 'Importación',
    body: '# Importar datos\n\nPrepare your file before importing.',
  };
  let submitted: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/help/support-requests')) {
        if (typeof init?.body !== 'string')
          throw new Error('Expected support request to use a JSON text body');
        submitted = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(jsonResponse({ id: orgId }));
      }
      if (url.includes('/help/articles/importing-data?'))
        return Promise.resolve(jsonResponse(contextualArticle));
      return Promise.resolve(
        jsonResponse({
          articles: [contextualArticle],
          categories: ['Importación'],
        }),
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const contextPath = `/console/orgs/${orgId}/onboarding/imports`;
  renderHelpCenter(
    `/console/orgs/${orgId}/help?article=importing-data&kind=concierge_import&locale=es&from=${encodeURIComponent(contextPath)}`,
  );

  expect(
    await screen.findByRole('heading', { name: 'Importar datos' }),
  ).toBeTruthy();
  expect(screen.getByRole('combobox')).toHaveProperty(
    'value',
    'concierge_import',
  );
  fireEvent.change(screen.getByLabelText('Asunto'), {
    target: { value: 'Ayuda con la importación' },
  });
  fireEvent.change(screen.getByLabelText('Mensaje'), {
    target: { value: 'Necesito ayuda para mapear mis datos.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

  expect(
    await screen.findByText('Solicitud enviada. Le responderemos pronto.'),
  ).toBeTruthy();
  await waitFor(() => {
    expect(submitted).toMatchObject({
      kind: 'concierge_import',
      context: { surface: 'console', path: contextPath },
    });
  });
});
