import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary, ToastProvider, useToast } from './app-feedback';

afterEach(() => vi.restoreAllMocks());

describe('app feedback', () => {
  it('contains render failures and recovers without exposing their message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    function Child(): React.JSX.Element {
      if (fail) throw new Error('private account detail');
      return <p>Recovered page</p>;
    }
    render(
      <MemoryRouter>
        <AppErrorBoundary>
          <Child />
        </AppErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'This page could not be displayed',
    );
    expect(screen.queryByText('private account detail')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered page')).toBeDefined();
  });

  it('announces and dismisses a live notification', () => {
    function Trigger(): React.JSX.Element {
      const notify = useToast();
      const [done, setDone] = useState(false);
      return (
        <button
          onClick={() => {
            notify('Profile saved', 'success');
            setDone(true);
          }}
        >
          {done ? 'Saved' : 'Save'}
        </button>
      );
    }
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('status').textContent).toContain('Profile saved');
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss notification' }),
    );
    expect(screen.queryByText('Profile saved')).toBeNull();
  });
});
