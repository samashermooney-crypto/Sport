import {
  authMeResponseSchema,
  authStatusResponseSchema,
} from '@shared/schemas/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { disconnectBrowserPush } from '../push/browser';
import { AuthFrame, AuthLink, Button, ErrorBox } from '../ui/auth';

export function AccountHome(): React.JSX.Element {
  const { t } = useTranslation('auth');
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
      setError(caught instanceof Error ? caught.message : t('signOutFailed'));
      setBusy(false);
    }
  }

  if (account.isPending)
    return (
      <AuthFrame>
        <h1>{t('loadingAccount')}</h1>
      </AuthFrame>
    );
  if (account.isError)
    return (
      <AuthFrame>
        <h1>{t('signInToContinue')}</h1>
        <p>{t('sessionUnavailable')}</p>
        <AuthLink to="/">{t('signIn')}</AuthLink>
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <h1>{t('welcomeAccount', { name: account.data.firstName })}</h1>
      <p>{t('signedInAs', { email: account.data.email })}</p>
      <ErrorBox error={error} />
      <p className="auth-secondary">
        <AuthLink to="/me/security">{t('accountSecurity')}</AuthLink>
      </p>
      <p className="auth-secondary">
        <AuthLink to="/start">{t('startOrganization')}</AuthLink>
      </p>
      <Button type="button" disabled={busy} onClick={() => void signOut()}>
        {busy ? t('signingOut') : t('signOut')}
      </Button>
    </AuthFrame>
  );
}
