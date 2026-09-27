import { personClaimInvitationResponseSchema } from '@shared/schemas/people';
import { useState } from 'react';

import { apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Card, Field, Input } from '../ui/primitives';

export function PersonClaim({
  orgId,
  personId,
  profileEmail,
}: {
  orgId: string;
  personId: string;
  profileEmail: string | null;
}): React.JSX.Element {
  const [email, setEmail] = useState(profileEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return (
    <Card>
      <h2>Adult account access</h2>
      <p>Send a one-time invitation to let this adult claim their profile.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setNotice('');
          void apiPost(
            `/people/orgs/${orgId}/${personId}/claim-invitations`,
            { email },
            personClaimInvitationResponseSchema,
          )
            .then(() => {
              setNotice(
                'Profile invitation sent. The recipient must verify their email and accept.',
              );
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Could not send invitation.',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <Field label="Adult account email">
          <Input
            type="email"
            required
            value={email}
            disabled={Boolean(profileEmail) || busy}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Send profile invitation
        </Button>
      </form>
      {notice && <p role="status">{notice}</p>}
      <ErrorBox error={error} />
    </Card>
  );
}
