import {
  athleteInvitationResponseSchema,
  athleteLinkResponseSchema,
} from '@shared/schemas/people';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiGet, apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Card, Field, Input } from '../ui/primitives';

export function AthleteAccess({
  orgId,
  personId,
}: {
  orgId: string;
  personId: string;
}): React.JSX.Element | null {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const path = `/people/orgs/${orgId}/${personId}/athlete-link`;
  const queryKey = ['athlete-link', orgId, personId];
  const link = useQuery({
    queryKey,
    queryFn: () => apiGet(path, athleteLinkResponseSchema),
    retry: false,
  });
  if (!link.data || link.data.age < 13 || link.data.age >= 18) return null;
  const connected = link.data.accountId !== null;
  return (
    <Card>
      <h2>Athlete account access</h2>
      {notice && <p role="status">{notice}</p>}
      {connected ? (
        <>
          <p>
            Linked account: {link.data.email} · verified{' '}
            {link.data.verifiedAt?.slice(0, 10)}
          </p>
          <Button
            type="button"
            secondary
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Revoke athlete account access for ${link.data.email ?? 'this athlete'}? Their sign-in sessions end immediately.`,
                )
              )
                return;
              setBusy(true);
              setError('');
              void apiPost(`${path}/revoke`, {}, athleteLinkResponseSchema)
                .then(async () => client.invalidateQueries({ queryKey }))
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Could not revoke athlete access.',
                  );
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            Revoke athlete access
          </Button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            setNotice('');
            void apiPost(
              `/people/orgs/${orgId}/${personId}/athlete-invitations`,
              { email },
              athleteInvitationResponseSchema,
            )
              .then(() => {
                setNotice(
                  'Athlete invitation sent. The athlete must verify their email and accept.',
                );
                setEmail('');
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
          <p>
            Invite this athlete to connect their own account. They get a
            read-only view of their profile.
          </p>
          <Field label="Athlete account email">
            <Input
              type="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Send athlete invitation
          </Button>
        </form>
      )}
      <ErrorBox error={error} />
    </Card>
  );
}
