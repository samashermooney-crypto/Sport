import {
  authSignInResponseSchema,
  authStatusResponseSchema,
} from '@shared/schemas/auth';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { apiPost } from '../api/client';
import { AuthFrame, AuthLink, Button, ErrorBox } from '../ui/auth';

type Purpose = 'verify' | 'magic' | 'email-change';

const content: Record<
  Purpose,
  { heading: string; action: string; endpoint: string }
> = {
  verify: {
    heading: 'verifyEmailTitle',
    action: 'verifyEmailAction',
    endpoint: '/auth/verify-email',
  },
  magic: {
    heading: 'magicRedeemTitle',
    action: 'signIn',
    endpoint: '/auth/magic/redeem',
  },
  'email-change': {
    heading: 'emailChangeTitle',
    action: 'emailChangeAction',
    endpoint: '/auth/email/change/confirm',
  },
};

export function TokenAction({
  purpose,
}: {
  purpose: Purpose;
}): React.JSX.Element {
  const { token } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation('auth');
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = content[purpose];

  async function act(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      if (purpose === 'magic') {
        const result = await apiPost(
          copy.endpoint,
          { token },
          authSignInResponseSchema,
        );
        if (result.status === 'mfa_required') {
          void navigate('/mfa', {
            replace: true,
            state: { challengeToken: result.challengeToken },
          });
          return;
        }
        void navigate('/me', { replace: true });
        return;
      }
      await apiPost(copy.endpoint, { token }, authStatusResponseSchema);
      setComplete(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('linkFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">{t('returnToSignIn')}</AuthLink>}>
      <h1>{t(copy.heading)}</h1>
      {complete ? (
        <p role="status">
          {purpose === 'verify' ? t('emailVerified') : t('emailChanged')}
        </p>
      ) : (
        <>
          <p>{t('oneUseLink')}</p>
          <ErrorBox error={error} />
          <Button
            type="button"
            disabled={busy || !token}
            onClick={() => void act()}
          >
            {busy ? t('working') : t(copy.action)}
          </Button>
        </>
      )}
    </AuthFrame>
  );
}
