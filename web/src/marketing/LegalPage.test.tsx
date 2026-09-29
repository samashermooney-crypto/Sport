import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegalPage } from './LegalPage';

function renderDocument(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/legal/${slug}`]}>
      <Routes>
        <Route path="/legal/:slug" element={<LegalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const legalDrafts = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'dpa', title: 'Data Processing Addendum' },
  { slug: 'acceptable-use', title: 'Acceptable Use Policy' },
  { slug: 'subprocessors', title: 'Subprocessors' },
  { slug: 'security', title: 'Security Overview' },
  { slug: 'accessibility', title: 'Accessibility Statement' },
];

describe('marketing legal pages', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it.each(legalDrafts)(
    '$title stays watermarked before legal approval',
    ({ slug, title }) => {
      const { container } = renderDocument(slug);
      expect(within(container).getByRole('status').textContent).toContain(
        'DRAFT — requires legal review',
      );
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    },
  );

  it('shows the review watermark on unapproved legal documents', () => {
    const { container } = renderDocument('privacy');
    expect(within(container).getByRole('status').textContent).toContain(
      'DRAFT — requires legal review',
    );
    expect(
      screen.getByRole('heading', { name: 'Privacy Policy' }).textContent,
    ).toBe('Privacy Policy');
    expect(
      screen.getByText(/children and family accounts/i).textContent,
    ).toMatch(/children and family accounts/i);
    expect(
      screen.getByText(/FERPA generally does not apply/i).textContent,
    ).toContain('FERPA generally does not apply');
    expect(screen.getByText(/COPPA/i).textContent).toContain(
      'COPPA and other children’s privacy laws',
    );
  });

  it('keeps the review watermark when approval is the string false', () => {
    vi.stubEnv('LEGAL_DOCS_APPROVED', 'false');
    const { container } = renderDocument('privacy');
    expect(within(container).getByRole('status').textContent).toContain(
      'DRAFT — requires legal review',
    );
  });

  it('renders a helpful not-found response for an unknown legal page', () => {
    renderDocument('unknown');
    expect(screen.getByRole('alert').textContent).toContain(
      'Document not found',
    );
    expect(
      screen
        .getByRole('link', { name: 'Return to Athlentry' })
        .getAttribute('href'),
    ).toBe('/welcome');
  });
});
