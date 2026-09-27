import {
  guardianInvitationResponseSchema,
  guardianLinksResponseSchema,
} from '@shared/schemas/people';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiGet, apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Card, Field, Input } from '../ui/primitives';

export function GuardianLinks({
  orgId,
  personId,
  readOnly,
}: {
  orgId: string;
  personId: string;
  readOnly: boolean;
}): React.JSX.Element {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const path = `/people/orgs/${orgId}/${personId}/guardians`;
  const queryKey = ['guardians', orgId, personId];
  const links = useQuery({
    queryKey,
    queryFn: () => apiGet(path, guardianLinksResponseSchema),
  });

  return (
    <Card>
      <h2>Guardians</h2>
      {notice && <p role="status">{notice}</p>}
      {links.isPending && <p>Loading guardians…</p>}
      {links.isError && <p>Guardians are unavailable.</p>}
      {links.data && (
        <ul>
          {links.data.items.map((link) => (
            <li key={link.id}>
              {link.name} ({link.email}){' '}
              {!readOnly && (
                <Button
                  type="button"
                  secondary
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Revoke guardian access for ${link.email}?`,
                      )
                    )
                      return;
                    setBusy(true);
                    setError('');
                    void apiPost(
                      `${path}/${link.id}/revoke`,
                      {},
                      guardianLinksResponseSchema,
                    )
                      .then(async () => client.invalidateQueries({ queryKey }))
                      .catch((cause: unknown) => {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : 'Could not revoke guardian.',
                        );
                      })
                      .finally(() => {
                        setBusy(false);
                      });
                  }}
                >
                  Revoke access
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {links.data?.items.length === 0 && <p>No guardian accounts linked.</p>}
      {!readOnly && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void apiPost(path, { email }, guardianLinksResponseSchema)
              .then(async () => {
                setEmail('');
                await client.invalidateQueries({ queryKey });
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Could not link guardian.',
                );
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <Field label="Existing verified adult account email">
            <Input
              id="guardian-email"
              type="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Link guardian
          </Button>
          <Button
            type="button"
            secondary
            disabled={busy || !email.trim()}
            onClick={() => {
              setBusy(true);
              setError('');
              setNotice('');
              void apiPost(
                `${path}/invitations`,
                { email },
                guardianInvitationResponseSchema,
              )
                .then(() => {
                  setNotice(
                    'Guardian invitation sent. The recipient must verify their email and accept.',
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
            Send invitation
          </Button>
        </form>
      )}
      <ErrorBox error={error} />
    </Card>
  );
}
