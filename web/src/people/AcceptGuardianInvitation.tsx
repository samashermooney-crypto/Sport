import { authMeResponseSchema } from '@shared/schemas/auth';
import { guardianInvitationAcceptedResponseSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button } from '../ui/primitives';

export function AcceptGuardianInvitation(): React.JSX.Element {
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
      <h1>Guardian invitation</h1>
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
            Signed in as {account.data.email}. Accept to manage this family
            member.
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
                `/people/orgs/${orgId}/guardians/invitations/accept`,
                { token },
                guardianInvitationAcceptedResponseSchema,
              )
                .then(() => {
                  setAccepted(true);
                  window.history.replaceState(null, '', '/me');
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
            {busy ? 'Accepting…' : 'Accept guardian invitation'}
          </Button>
        </>
      )}
      {accepted && (
        <>
          <p role="status">Guardian access is active.</p>
          <AuthLink to="/me">Open account</AuthLink>
        </>
      )}
    </AuthFrame>
  );
}
