import { authMeResponseSchema } from '@shared/schemas/auth';
import { acceptedOrgInvitationResponseSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button } from '../ui/primitives';

export function AcceptInvitation(): React.JSX.Element {
  const { orgId, token } = useParams();
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  async function accept(): Promise<void> {
    if (!orgId || !token) return;
    setBusy(true);
    setError('');
    try {
      await apiPost(
        `/orgs/${orgId}/invitations/accept`,
        { token },
        acceptedOrgInvitationResponseSchema,
      );
      setAccepted(true);
      window.history.replaceState(null, '', '/me');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Invitation could not be accepted.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame footer={<AuthLink to="/me">Account</AuthLink>}>
      <h1>Join this organization</h1>
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
            Signed in as {account.data.email}. Accept this invitation to join
            the organization.
          </p>
          <ErrorBox error={error} />
          <Button type="button" disabled={busy} onClick={() => void accept()}>
            {busy ? 'Joining…' : 'Accept invitation'}
          </Button>
        </>
      )}
      {accepted && (
        <>
          <p role="status">
            Invitation accepted. Set up MFA to activate any admin or finance
            role.
          </p>
          <AuthLink to="/me/security">Open account security</AuthLink>
        </>
      )}
    </AuthFrame>
  );
}
