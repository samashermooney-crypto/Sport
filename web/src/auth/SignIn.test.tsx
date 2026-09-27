import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '../lib/i18n';

import { SignIn } from './SignIn';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('sign-in form', () => {
  it('requires valid credentials before submitting', async () => {
    render(
      <MemoryRouter>
        <SignIn />
      </MemoryRouter>,
    );
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
    render(
      <MemoryRouter>
        <SignIn />
      </MemoryRouter>,
    );
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
});
