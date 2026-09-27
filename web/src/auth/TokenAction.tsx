import {
  authSignInResponseSchema,
  authStatusResponseSchema,
} from '@shared/schemas/auth';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { apiPost } from '../api/client';
import { AuthFrame, AuthLink, Button, ErrorBox } from '../ui/auth';

type Purpose = 'verify' | 'magic' | 'email-change';

const content: Record<
  Purpose,
  { heading: string; action: string; endpoint: string }
> = {
  verify: {
    heading: 'Verify your email',
    action: 'Verify email',
    endpoint: '/auth/verify-email',
  },
  magic: {
    heading: 'Sign in with your link',
    action: 'Sign in',
    endpoint: '/auth/magic/redeem',
  },
  'email-change': {
    heading: 'Confirm your new email',
    action: 'Confirm email',
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
      setError(
        caught instanceof Error
          ? caught.message
          : 'The link could not be used.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">Return to sign in</AuthLink>}>
      <h1>{copy.heading}</h1>
      {complete ? (
        <p role="status">
          {purpose === 'verify'
            ? 'Email verified. You can now sign in.'
            : 'Email changed. Please sign in again.'}
        </p>
      ) : (
        <>
          <p>This link can be used once. Continue to confirm the request.</p>
          <ErrorBox error={error} />
          <Button
            type="button"
            disabled={busy || !token}
            onClick={() => void act()}
          >
            {busy ? 'Working…' : copy.action}
          </Button>
        </>
      )}
    </AuthFrame>
  );
}
