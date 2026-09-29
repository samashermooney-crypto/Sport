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
