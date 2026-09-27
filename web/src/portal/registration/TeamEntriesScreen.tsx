import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';

import '../money/money.css';
import './registration.css';

const optionsSchema = z.strictObject({
  offerings: z.array(
    z.strictObject({
      offeringId: z.uuid(),
      programName: z.string(),
      divisionName: z.string(),
      offeringName: z.string(),
      requiresApproval: z.boolean(),
    }),
  ),
  captains: z.array(z.strictObject({ personId: z.uuid(), name: z.string() })),
});
const entriesSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      id: z.uuid(),
      teamName: z.string(),
      programId: z.uuid(),
      programName: z.string(),
      divisionId: z.uuid(),
      divisionName: z.string(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      captainPersonId: z.uuid().nullable(),
      status: z.string(),
      seedHint: z.number().int().nullable(),
      createdAt: z.iso.datetime(),
      inviteCount: z.number().int().nonnegative(),
    }),
  ),
});
const entrySchema = entriesSchema.shape.entries.element;
const invitesSchema = z.strictObject({
  invites: z.array(
    z.strictObject({
      id: z.uuid(),
      email: z.email(),
      expiresAt: z.iso.datetime(),
      inviteUrl: z.url(),
    }),
  ),
});

export function TeamEntriesScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const base = `/registration/orgs/${encodeURIComponent(orgId)}`;
  const [offeringId, setOfferingId] = useState('');
  const [captainPersonId, setCaptainPersonId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [clubName, setClubName] = useState('');
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const [createdInvites, setCreatedInvites] = useState<
    Record<string, z.output<typeof invitesSchema>['invites']>
  >({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const options = useQuery({
    queryKey: ['registration', orgId, 'team-entry-options'],
    queryFn: () => apiGet(`${base}/team-entry-options`, optionsSchema),
  });
  const entries = useQuery({
    queryKey: ['registration', orgId, 'team-entries-mine'],
    queryFn: () => apiGet(`${base}/me/team-entries`, entriesSchema),
  });

  const createEntry = async (): Promise<void> => {
    if (!offeringId || !captainPersonId || !teamName.trim() || busy) return;
    setBusy('create');
    setError('');
    try {
      const entry = await apiPost(
        `${base}/team-entries`,
        {
          offeringId,
          captainPersonId,
          teamName: teamName.trim(),
          ...(clubName.trim() ? { clubName: clubName.trim() } : {}),
        },
        entrySchema,
        crypto.randomUUID(),
      );
      await queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'team-entries-mine'],
      });
      setTeamName('');
      setClubName('');
      setOfferingId('');
      setError(
        entry.status === 'pending_approval'
          ? 'Team registered. The organization will review it.'
          : 'Team registered.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Team entry failed.');
    } finally {
      setBusy('');
    }
  };

  const invitePlayers = async (entryId: string): Promise<void> => {
    const emails = (inviteEmails[entryId] ?? '')
      .split(/[\n,;]/)
      .map((email) => email.trim())
      .filter(Boolean);
    if (!emails.length || busy) return;
    setBusy(entryId);
    setError('');
    try {
      const result = await apiPost(
        `${base}/team-entries/${encodeURIComponent(entryId)}/invites`,
        { emails },
        invitesSchema,
      );
      setCreatedInvites((current) => ({
        ...current,
        [entryId]: result.invites,
      }));
      setInviteEmails((current) => ({ ...current, [entryId]: '' }));
      await queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'team-entries-mine'],
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Invites could not be created.',
      );
    } finally {
      setBusy('');
    }
  };

  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="TEAM REGISTRATION"
          title="Register a team"
          description="A verified adult captain can enter a team and invite each player to complete their own registration."
        />
        <p>
          <Link to={`/portal/orgs/${orgId}/register`}>
            Register as a player
          </Link>
          {' · '}
          <Link to={`/portal/orgs/${orgId}/registrations`}>
            My registrations
          </Link>
        </p>
        {error ? <p role="status">{error}</p> : null}
        {(options.isLoading || entries.isLoading) && (
          <p role="status">Loading team registration…</p>
        )}
        {options.error || entries.error ? (
          <p role="alert" className="money-error">
            Team registration is unavailable. Try again.
          </p>
        ) : null}
        {options.data ? (
          <section aria-labelledby="team-entry-create-title">
            <h2 id="team-entry-create-title">New team entry</h2>
            {options.data.offerings.length === 0 ||
            options.data.captains.length === 0 ? (
              <p>
                There are no open team offerings for a verified adult captain.
              </p>
            ) : (
              <div className="registration-team-form">
                <label>
                  Program and division
                  <select
                    value={offeringId}
                    onChange={(event) => {
                      setOfferingId(event.currentTarget.value);
                    }}
                  >
                    <option value="">Choose a team offering</option>
                    {options.data.offerings.map((offering) => (
                      <option
                        key={offering.offeringId}
                        value={offering.offeringId}
                      >
                        {offering.programName} · {offering.divisionName} ·{' '}
                        {offering.offeringName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Captain
                  <select
                    value={captainPersonId}
                    onChange={(event) => {
                      setCaptainPersonId(event.currentTarget.value);
                    }}
                  >
                    <option value="">Choose the adult captain</option>
                    {options.data.captains.map((captain) => (
                      <option key={captain.personId} value={captain.personId}>
                        {captain.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Team name
                  <input
                    value={teamName}
                    maxLength={100}
                    onChange={(event) => {
                      setTeamName(event.currentTarget.value);
                    }}
                  />
                </label>
                <label>
                  Club name (optional)
                  <input
                    value={clubName}
                    maxLength={100}
                    onChange={(event) => {
                      setClubName(event.currentTarget.value);
                    }}
                  />
                </label>
                <Button
                  disabled={
                    busy !== '' ||
                    !offeringId ||
                    !captainPersonId ||
                    teamName.trim().length < 2
                  }
                  onClick={() => {
                    void createEntry();
                  }}
                >
                  {busy === 'create' ? 'Registering…' : 'Register team'}
                </Button>
              </div>
            )}
          </section>
        ) : null}
        {entries.data ? (
          <section aria-labelledby="team-entry-list-title">
            <h2 id="team-entry-list-title">Your team entries</h2>
            {entries.data.entries.length === 0 ? (
              <p>No team entries yet.</p>
            ) : (
              <div className="registration-team-entry-list">
                {entries.data.entries.map((entry) => (
                  <article className="money-card" key={entry.id}>
                    <h3>{entry.teamName}</h3>
                    <p>
                      {entry.programName} · {entry.divisionName} ·{' '}
                      {entry.status}
                    </p>
                    <p>{entry.inviteCount} player invitations</p>
                    {['pending_approval', 'accepted'].includes(entry.status) ? (
                      <div className="registration-team-form">
                        <label htmlFor={`team-entry-emails-${entry.id}`}>
                          Player emails (one per line)
                        </label>
                        <textarea
                          id={`team-entry-emails-${entry.id}`}
                          rows={5}
                          value={inviteEmails[entry.id] ?? ''}
                          onChange={(event) => {
                            setInviteEmails((current) => ({
                              ...current,
                              [entry.id]: event.currentTarget.value,
                            }));
                          }}
                        />
                        <Button
                          disabled={
                            busy !== '' ||
                            !(inviteEmails[entry.id] ?? '').trim()
                          }
                          onClick={() => {
                            void invitePlayers(entry.id);
                          }}
                        >
                          {busy === entry.id
                            ? 'Creating invites…'
                            : 'Invite players'}
                        </Button>
                        {createdInvites[entry.id]?.map((invite) => (
                          <p key={invite.id}>
                            <a href={invite.inviteUrl}>{invite.email}</a>
                            {' · '}
                            <a
                              href={`mailto:${encodeURIComponent(invite.email)}?body=${encodeURIComponent(invite.inviteUrl)}`}
                            >
                              Email invite link
                            </a>
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}
        <p className="registration-team-note">
          Team entries do not have a team fee. Each player uses their own
          registration checkout.
        </p>
      </main>
    </PortalShell>
  );
}
