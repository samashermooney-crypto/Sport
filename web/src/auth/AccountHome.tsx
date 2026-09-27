import {
  authMeResponseSchema,
  authStatusResponseSchema,
} from '@shared/schemas/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { disconnectBrowserPush } from '../push/browser';
import { AuthFrame, AuthLink, Button, ErrorBox } from '../ui/auth';

export function AccountHome(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    retry: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await disconnectBrowserPush();
      await apiPost('/auth/sign-out', {}, authStatusResponseSchema);
      queryClient.removeQueries({ queryKey: ['auth'] });
      void navigate('/', { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-out failed.');
      setBusy(false);
    }
  }

  if (account.isPending)
    return (
      <AuthFrame>
        <h1>Loading account…</h1>
      </AuthFrame>
    );
  if (account.isError)
    return (
      <AuthFrame>
        <h1>Sign in to continue</h1>
        <p>Your session could not be loaded.</p>
        <AuthLink to="/">Sign in</AuthLink>
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <h1>Welcome, {account.data.firstName}.</h1>
      <p>Signed in as {account.data.email}</p>
      <ErrorBox error={error} />
      <p className="auth-secondary">
        <AuthLink to="/me/security">Account security</AuthLink>
      </p>
      <p className="auth-secondary">
        <AuthLink to="/start">Start an organization</AuthLink>
      </p>
      <Button type="button" disabled={busy} onClick={() => void signOut()}>
        {busy ? 'Signing out…' : 'Sign out'}
      </Button>
    </AuthFrame>
  );
}
