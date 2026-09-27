import { authMeResponseSchema } from '@shared/schemas/auth';
import { athleteInvitationAcceptedResponseSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button } from '../ui/primitives';

export function AcceptAthleteInvitation(): React.JSX.Element {
  const { orgId, token } = useParams();
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  return (
    <AuthFrame footer={<AuthLink to="/me">Account</AuthLink>}>
      <h1>Athlete invitation</h1>
      {account.isPending && <p role="status">Checking your account…</p>}
      {account.isError && (
        <>
          <p>
            Sign in with the invited email address, then return to this link.
          </p>
          <p>
            <AuthLink to="/">Sign in</AuthLink> ·{' '}
            <AuthLink to="/sign-up">Create an account</AuthLink>
          </p>
        </>
      )}
      {account.isSuccess && !accepted && (
        <>
          <p>
            Signed in as {account.data.email}. Accept to connect your athlete
            profile.
          </p>
          <ErrorBox error={error} />
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!orgId || !token) return;
              setBusy(true);
              setError('');
              void apiPost(
                `/people/orgs/${orgId}/athlete-invitations/accept`,
                { token },
                athleteInvitationAcceptedResponseSchema,
              )
                .then(() => {
                  setAccepted(true);
                  window.history.replaceState(null, '', '/me/family');
                })
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Invitation could not be accepted.',
                  );
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {busy ? 'Accepting…' : 'Accept athlete invitation'}
          </Button>
        </>
      )}
      {accepted && (
        <>
          <p role="status">Your athlete profile is linked.</p>
          <AuthLink to="/me/family">Open family</AuthLink>
        </>
      )}
    </AuthFrame>
  );
}
