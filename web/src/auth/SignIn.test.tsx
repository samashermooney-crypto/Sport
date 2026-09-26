import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SignIn } from './SignIn';

describe('Phase 0 sign-in shell', () => {
  it('shows the Athlentry sign-in skeleton without dead actions', () => {
    render(<SignIn />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.getByText('Athlentry')).toBeDefined();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
