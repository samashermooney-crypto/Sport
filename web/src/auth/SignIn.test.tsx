import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../lib/i18n';

import { SignIn } from './SignIn';

function signedOut() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
        }),
    }),
  );
}

function renderSignIn() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/me" element={<h1>Account home</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  signedOut();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

describe('sign-in form', () => {
  it('requires valid credentials before submitting', async () => {
    renderSignIn();
    expect(
      screen.getByRole('heading', { name: 'Welcome back.' }),
    ).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Forgot your password?' }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.getByText('Enter your email address.')).toBeDefined();
      expect(screen.getByText('Enter your password.')).toBeDefined();
    });
  });

  it('switches sign-in and validation copy to Spanish', async () => {
    renderSignIn();
    fireEvent.change(screen.getByLabelText('Language'), {
      target: { value: 'es' },
    });
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Le damos la bienvenida.' }),
      ).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    await waitFor(() => {
      expect(screen.getByText('Ingrese su correo electrónico.')).toBeDefined();
    });
    expect(document.documentElement.lang).toBe('es');
  });

  it('sends someone who is already signed in to their account home', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: '01a0f417-dcb1-709b-8f3d-f563cd68e8e8',
            email: 'admin@example.test',
            firstName: 'Demo',
            lastName: 'Admin',
            locale: 'en',
            mfaEnabled: false,
            sessionId: '01a0f417-dcb7-7573-8347-e6510b11cc3b',
            client: 'web',
          }),
      }),
    );
    renderSignIn();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Account home' }),
      ).toBeDefined();
    });
  });
});
