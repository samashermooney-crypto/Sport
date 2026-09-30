import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { i18n } from '../lib/i18n';

import { ConsoleShell } from './ConsoleShell';

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

it('localizes the organization shell navigation and search in Spanish', async () => {
  await i18n.changeLanguage('es');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/console/orgs/test-org']}>
        <ConsoleShell orgId="test-org">
          <main>Workspace</main>
        </ConsoleShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const primaryNavigation = screen.getByRole('navigation', {
    name: 'Navegación principal',
  });
  expect(primaryNavigation.getAttribute('aria-label')).toBe(
    'Navegación principal',
  );
  expect(
    screen
      .getByRole('navigation', { name: 'Navegación móvil' })
      .getAttribute('aria-label'),
  ).toBe('Navegación móvil');
  expect(screen.getByRole('link', { name: 'Ayuda' }).getAttribute('href')).toBe(
    '/console/orgs/test-org/help?article=support&kind=support&locale=es&from=%2Fconsole%2Forgs%2Ftest-org',
  );
  expect(
    screen
      .getByRole('button', { name: 'Buscar en Athlentry' })
      .getAttribute('aria-label'),
  ).toBe('Buscar en Athlentry');
  fireEvent.click(screen.getByRole('button', { name: 'Administrar' }));
  expect(
    primaryNavigation.querySelector('a[href$="/people"]')?.textContent,
  ).toBe('Personas');
  expect(
    primaryNavigation.querySelector('a[href$="/households"]')?.textContent,
  ).toBe('Familias');
});

const federationTestOrgId = '0199a413-a221-7000-8000-000000000003';

function stubConsoleApi(capabilities: Record<string, boolean>): void {
  const responses: Record<string, unknown> = {
    [`/api/v1/orgs/${federationTestOrgId}/workspace`]: {
      id: federationTestOrgId,
      name: 'Northstar Club',
      slug: 'northstar-club',
      canManage: true,
      canAudit: true,
    },
    '/api/v1/orgs/mine': [],
    [`/api/v1/federation/organizations/${federationTestOrgId}/capabilities`]:
      capabilities,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(requestUrl, 'http://localhost').pathname;
      const exists = Object.prototype.hasOwnProperty.call(responses, path);
      return Promise.resolve(
        new Response(JSON.stringify(responses[path] ?? {}), {
          status: exists ? 200 : 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

function renderFederationShell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/console/orgs/${federationTestOrgId}/people`]}
      >
        <ConsoleShell orgId={federationTestOrgId}>
          <main>Workspace</main>
        </ConsoleShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

it('shows Federation navigation only when the caller has a federation capability', async () => {
  stubConsoleApi({
    relationships: true,
    manageRelationships: false,
    directory: false,
    submitEntries: false,
    schedule: false,
    discipline: false,
    referees: false,
    finance: false,
  });
  const client = renderFederationShell();
  fireEvent.click(await screen.findByRole('button', { name: 'Operations' }));
  const federationLink = await screen.findByRole('link', {
    name: 'Federation',
  });
  expect(federationLink.getAttribute('href')).toBe(
    `/console/federation/${federationTestOrgId}`,
  );
  client.clear();
});

it('hides Federation navigation when the caller has no federation capability', async () => {
  stubConsoleApi({
    relationships: false,
    manageRelationships: false,
    directory: false,
    submitEntries: false,
    schedule: false,
    discipline: false,
    referees: false,
    finance: false,
  });
  const client = renderFederationShell();
  fireEvent.click(await screen.findByRole('button', { name: 'Operations' }));
  expect(screen.queryByRole('link', { name: 'Federation' })).toBeNull();
  client.clear();
});
