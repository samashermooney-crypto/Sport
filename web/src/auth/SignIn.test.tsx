import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { SignIn } from './SignIn';

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
});
