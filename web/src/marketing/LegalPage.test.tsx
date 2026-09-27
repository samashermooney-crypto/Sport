import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

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

describe('marketing legal pages', () => {
  it('shows the review watermark on unapproved legal documents', () => {
    renderDocument('privacy');
    expect(screen.getByRole('status').textContent).toContain(
      'DRAFT — requires legal review',
    );
    expect(
      screen.getByRole('heading', { name: 'Privacy Policy' }).textContent,
    ).toBe('Privacy Policy');
    expect(
      screen.getByText(/children and family accounts/i).textContent,
    ).toMatch(/children and family accounts/i);
    expect(screen.getByText(/FERPA/i).textContent).toContain('FERPA');
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
