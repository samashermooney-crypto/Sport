import { authMeResponseSchema } from '@shared/schemas/auth';
import { ownershipTransferAcceptResponseSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button } from '../ui/primitives';

export function AcceptOwnershipTransfer(): React.JSX.Element {
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
        `/orgs/${orgId}/ownership-transfer/accept`,
        { token },
        ownershipTransferAcceptResponseSchema,
      );
      setAccepted(true);
      window.history.replaceState(null, '', '/me');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Ownership transfer could not be accepted.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame footer={<AuthLink to="/me">Account</AuthLink>}>
      <h1>Accept organization ownership</h1>
      {account.isPending && <p role="status">Checking your account…</p>}
      {account.isError && (
        <p>
          Sign in with the recipient account, then return to this link.{' '}
          <AuthLink to="/">Sign in</AuthLink>
        </p>
      )}
      {account.isSuccess && !accepted && (
        <>
          <p>
            Signed in as {account.data.email}. Accepting transfers the owner
            role from the current owner to you. Your account must have MFA
            enabled. Both accounts will be signed out after acceptance.
          </p>
          <ErrorBox error={error} />
          <Button type="button" disabled={busy} onClick={() => void accept()}>
            {busy ? 'Accepting…' : 'Accept ownership'}
          </Button>
        </>
      )}
      {accepted && (
        <>
          <p role="status">Ownership transferred. Sign in again to continue.</p>
          <AuthLink to="/">Sign in</AuthLink>
        </>
      )}
    </AuthFrame>
  );
}
