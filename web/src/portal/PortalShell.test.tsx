import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '../lib/i18n';

import { PortalShell } from './PortalShell';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('family portal navigation', () => {
  it('links to the organization Classes page on desktop and mobile', async () => {
    await i18n.changeLanguage('en');
    const orgId = '0199a413-a221-7000-8000-000000000003';
    const classesPath = `/me/orgs/${orgId}/classes`;

    render(
      <MemoryRouter initialEntries={[classesPath]}>
        <PortalShell orgId={orgId}>
          <main>Family portal</main>
        </PortalShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    const classesLinks = screen.getAllByRole('link', { name: 'Classes' });
    expect(classesLinks).toHaveLength(2);
    for (const link of classesLinks) {
      expect(link.getAttribute('href')).toBe(classesPath);
      expect(link.getAttribute('aria-current')).toBe('page');
    }
  });
});
