import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';

import '../money/money.css';
import './registration.css';

const inviteSchema = z.strictObject({
  entryId: z.uuid(),
  teamName: z.string(),
  programName: z.string(),
  divisionName: z.string(),
  email: z.email(),
  status: z.enum(['pending', 'accepted', 'expired', 'canceled']),
  expiresAt: z.iso.datetime(),
});
const participantsSchema = z.strictObject({
  people: z.array(
    z.strictObject({
      personId: z.uuid(),
      householdId: z.uuid(),
      name: z.string(),
      householdName: z.string(),
    }),
  ),
});
const acceptedSchema = z.strictObject({ checkoutId: z.uuid() });

export function TeamEntryInviteScreen({
  orgId,
  token,
}: {
  orgId: string;
  token: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [personChoice, setPersonChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/registration/orgs/${encodeURIComponent(orgId)}`;
  const invite = useQuery({
    queryKey: ['registration', orgId, 'team-entry-invite', token],
    queryFn: () =>
      apiGet(
        `${base}/team-entry-invites/${encodeURIComponent(token)}`,
        inviteSchema,
      ),
    retry: false,
  });
  const participants = useQuery({
    queryKey: ['registration', orgId, 'participants'],
    queryFn: () => apiGet(`${base}/participants`, participantsSchema),
    enabled: invite.data?.status === 'pending',
  });

  const accept = async (): Promise<void> => {
    if (!personChoice || busy) return;
    const [personId, householdId] = personChoice.split(':');
    if (!personId || !householdId) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiPost(
        `${base}/team-entry-invites/${encodeURIComponent(token)}/accept`,
        { personId, householdId },
        acceptedSchema,
      );
      void navigate(
        `/portal/orgs/${orgId}/register/checkouts/${result.checkoutId}/requirements`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'This team invitation could not be accepted.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="TEAM INVITATION"
          title="Join a team"
          description="Accepting opens the normal player registration checkout for the selected family member."
        />
        <p>
          <Link to={`/portal/orgs/${orgId}/register`}>Browse programs</Link>
        </p>
        {invite.isLoading ? <p role="status">Loading invitation…</p> : null}
        {invite.error ? (
          <p role="alert" className="money-error">
            This invitation is unavailable. Ask the captain for a new link.
          </p>
        ) : null}
        {invite.data ? (
          <section className="money-panel" aria-labelledby="team-invite-title">
            <h2 id="team-invite-title">{invite.data.teamName}</h2>
            <p>
              {invite.data.programName} · {invite.data.divisionName}
            </p>
            <p>Invitation for {invite.data.email}</p>
            {invite.data.status === 'pending' ? (
              <>
                {participants.isLoading ? (
                  <p role="status">Loading family members…</p>
                ) : null}
                {participants.error ? (
                  <p role="alert" className="money-error">
                    Family members are unavailable. Refresh to try again.
                  </p>
                ) : null}
                {participants.data ? (
                  participants.data.people.length ? (
                    <div className="registration-team-form">
                      <label htmlFor="team-invite-person">
                        Register this family member
                      </label>
                      <select
                        id="team-invite-person"
                        value={personChoice}
                        onChange={(event) => {
                          setPersonChoice(event.currentTarget.value);
                        }}
                      >
                        <option value="">Choose a family member</option>
                        {participants.data.people.map((person) => (
                          <option
                            key={`${person.personId}:${person.householdId}`}
                            value={`${person.personId}:${person.householdId}`}
                          >
                            {person.name} · {person.householdName}
                          </option>
                        ))}
                      </select>
                      <Button
                        disabled={!personChoice || busy}
                        onClick={() => void accept()}
                      >
                        {busy ? 'Opening checkout…' : 'Accept and continue'}
                      </Button>
                    </div>
                  ) : (
                    <p>
                      Add the player to your family before accepting this
                      invitation.
                    </p>
                  )
                ) : null}
              </>
            ) : (
              <p role="status">
                This invitation is {invite.data.status}. Contact the captain if
                you need an active invitation.
              </p>
            )}
            {error ? (
              <p role="alert" className="money-error">
                {error}
              </p>
            ) : null}
          </section>
        ) : null}
      </main>
    </PortalShell>
  );
}
