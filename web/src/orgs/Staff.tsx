import { authMeResponseSchema } from '@shared/schemas/auth';
import {
  orgInvitationResponseSchema,
  orgMemberRolesResponseSchema,
  orgMemberStatusResponseSchema,
  ownershipTransferRequestResponseSchema,
  scopedRoleResponseSchema,
  orgRoleSchema,
  orgStaffResponseSchema,
} from '@shared/schemas/orgs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiDelete, apiGet, apiPatch, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button, Field, Input, Select } from '../ui/primitives';

type Staff = z.output<typeof orgStaffResponseSchema>;
type Member = Staff['members'][number];
const roleOptions = orgRoleSchema.options.filter((role) => role !== 'owner');

function MemberEditor({
  orgId,
  member,
  lastOwner,
  ownerVersion,
}: {
  orgId: string;
  member: Member;
  lastOwner: boolean;
  ownerVersion: number | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [roles, setRoles] = useState<string[]>(
    member.roles
      .filter((role) => role.scopeType === 'org')
      .map((role) => role.role),
  );
  const [scopedRole, setScopedRole] =
    useState<(typeof roleOptions)[number]>('registrar');
  const [scopeType, setScopeType] = useState<
    'season' | 'program' | 'division' | 'team_season'
  >('program');
  const [scopeId, setScopeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `/orgs/${orgId}/members/${member.accountId}/roles`,
        {
          roles,
          expectedVersion: member.version,
        },
        orgMemberRolesResponseSchema,
      );
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'staff'],
      });
      setNotice('Roles saved. Other sessions for this member were revoked.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Roles could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus(
    status: 'active' | 'suspended' | 'removed',
  ): Promise<void> {
    if (
      status === 'removed' &&
      !window.confirm(`Remove ${member.name} from this organization?`)
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `/orgs/${orgId}/members/${member.accountId}/status`,
        {
          status,
          expectedVersion: member.version,
        },
        orgMemberStatusResponseSchema,
      );
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'staff'],
      });
      setNotice(
        `Membership ${status}. Other sessions for this member were revoked.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Membership could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function changeScopedRole(
    role: (typeof roleOptions)[number],
    type: typeof scopeType,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `/orgs/${orgId}/members/${member.accountId}/scoped-role`,
        {
          role,
          scopeType: type,
          scopeId: id,
          enabled,
          expectedVersion: member.version,
        },
        scopedRoleResponseSchema,
      );
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'staff'],
      });
      setNotice(enabled ? 'Scoped role granted.' : 'Scoped role revoked.');
      if (enabled) setScopeId('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Scoped role could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function transferOwnership(): Promise<void> {
    if (
      !ownerVersion ||
      !window.confirm(
        `Ask ${member.name} to accept ownership of this organization? Your owner role will end when they accept.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `/orgs/${orgId}/ownership-transfer`,
        {
          recipientAccountId: member.accountId,
          expectedVersion: ownerVersion,
        },
        ownershipTransferRequestResponseSchema,
        crypto.randomUUID(),
      );
      setNotice(`Ownership acceptance link sent to ${member.email}.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Ownership transfer could not be requested.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="start-credential-card"
      aria-label={`Roles for ${member.name}`}
    >
      <h3>{member.name}</h3>
      <p>
        {member.email} · {member.status}
      </p>
      {member.roles.some((role) => role.pendingMfa) && (
        <p role="status">MFA enrollment pending</p>
      )}
      {member.roles
        .filter((role) => role.scopeType !== 'org')
        .map((assignment) => (
          <p
            key={`${assignment.role}:${assignment.scopeType}:${String(assignment.scopeId)}`}
          >
            {assignment.role} · {assignment.scopeType} · {assignment.scopeId}
            {assignment.pendingMfa ? ' · MFA pending' : ''}{' '}
            {member.status === 'active' && (
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void changeScopedRole(
                    assignment.role as (typeof roleOptions)[number],
                    assignment.scopeType as typeof scopeType,
                    String(assignment.scopeId),
                    false,
                  )
                }
              >
                Revoke scoped role
              </Button>
            )}
          </p>
        ))}
      {member.status === 'active' && (
        <fieldset>
          <legend>Grant scoped role</legend>
          <Field label="Role">
            <Select
              value={scopedRole}
              onChange={(event) => {
                setScopedRole(event.target.value as typeof scopedRole);
              }}
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope">
            <Select
              value={scopeType}
              onChange={(event) => {
                setScopeType(event.target.value as typeof scopeType);
              }}
            >
              <option value="season">Season</option>
              <option value="program">Program</option>
              <option value="division">Division</option>
              <option value="team_season">Team season</option>
            </Select>
          </Field>
          <Field label="Scope ID" required>
            <Input
              value={scopeId}
              onChange={(event) => {
                setScopeId(event.target.value);
              }}
            />
          </Field>
          <Button
            type="button"
            disabled={busy || !z.uuid().safeParse(scopeId).success}
            onClick={() =>
              void changeScopedRole(scopedRole, scopeType, scopeId, true)
            }
          >
            Grant scoped role
          </Button>
        </fieldset>
      )}
      {member.status === 'active' && (
        <fieldset>
          <legend>Organization roles</legend>
          {member.roles.some(
            (role) => role.role === 'owner' && role.scopeType === 'org',
          ) && (
            <p>
              Owner · transfer ownership to grant this role to another member.
            </p>
          )}
          {roleOptions.map((role) => (
            <label className="start-credential-check" key={role}>
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={(event) => {
                  setRoles(
                    event.target.checked
                      ? [...roles, role]
                      : roles.filter((item) => item !== role),
                  );
                }}
              />{' '}
              {role.replaceAll('_', ' ')}
            </label>
          ))}
        </fieldset>
      )}
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      {member.status === 'active' && (
        <Button
          type="button"
          disabled={busy || roles.length === 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save roles'}
        </Button>
      )}
      {ownerVersion &&
        member.status === 'active' &&
        !member.roles.some(
          (role) => role.role === 'owner' && role.scopeType === 'org',
        ) && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void transferOwnership()}
          >
            Request ownership transfer
          </Button>
        )}
      {lastOwner && (
        <p>The last active owner cannot be suspended or removed.</p>
      )}
      {!lastOwner && member.status === 'active' && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void changeStatus('suspended')}
        >
          Suspend membership
        </Button>
      )}
      {!lastOwner && member.status === 'suspended' && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void changeStatus('active')}
        >
          Reactivate membership
        </Button>
      )}
      {!lastOwner && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void changeStatus('removed')}
        >
          Remove membership
        </Button>
      )}
    </section>
  );
}

export function Staff(): React.JSX.Element {
  const { orgId } = useParams();
  const id = String(orgId);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['orgs', id, 'staff'],
    queryFn: () => apiGet(`/orgs/${id}/staff`, orgStaffResponseSchema),
    enabled: Boolean(orgId),
    retry: false,
  });
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    retry: false,
  });
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['admin']);
  const [scopeType, setScopeType] = useState<
    'org' | 'season' | 'program' | 'division' | 'team_season'
  >('org');
  const [scopeId, setScopeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function invite(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `/orgs/${id}/invitations`,
        {
          email,
          roles,
          scopeType,
          scopeId: scopeType === 'org' ? null : scopeId,
        },
        orgInvitationResponseSchema,
        crypto.randomUUID(),
      );
      setNotice(`Invitation sent to ${email}.`);
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['orgs', id, 'staff'] });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Invitation could not be sent.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function actOnInvitation(
    invitationId: string,
    action: 'resend' | 'revoke',
  ): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'resend') {
        await apiPost(
          `/orgs/${id}/invitations/${invitationId}/resend`,
          {},
          orgInvitationResponseSchema,
          crypto.randomUUID(),
        );
        setNotice('Invitation resent. The earlier link no longer works.');
      } else {
        await apiDelete(
          `/orgs/${id}/invitations/${invitationId}`,
          z.strictObject({ revoked: z.literal(true) }),
        );
        setNotice('Invitation revoked.');
      }
      await queryClient.invalidateQueries({ queryKey: ['orgs', id, 'staff'] });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Invitation could not be updated.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/me">Back to your account</AuthLink>}>
      <h1>Users and roles</h1>
      <p>
        Only active owners can manage staff. Confirm your identity in{' '}
        <AuthLink to="/me/security">account security</AuthLink> before inviting
        or changing roles.
      </p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      {query.isPending && <p role="status">Loading staff…</p>}
      {query.isError && (
        <ErrorBox error="Staff could not be loaded. Check your owner access." />
      )}
      {query.isSuccess && (
        <>
          <section aria-label="Invite staff">
            <h2>Invite staff</h2>
            <Field label="Email address" required>
              <Input
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                autoComplete="email"
              />
            </Field>
            <fieldset>
              <legend>Roles</legend>
              {roleOptions.map((role) => (
                <label className="start-credential-check" key={role}>
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={(event) => {
                      setRoles(
                        event.target.checked
                          ? [...roles, role]
                          : roles.filter((item) => item !== role),
                      );
                    }}
                  />{' '}
                  {role.replaceAll('_', ' ')}
                </label>
              ))}
            </fieldset>
            <Field label="Scope">
              <Select
                value={scopeType}
                onChange={(event) => {
                  setScopeType(event.target.value as typeof scopeType);
                }}
              >
                <option value="org">Whole organization</option>
                <option value="season">Season</option>
                <option value="program">Program</option>
                <option value="division">Division</option>
                <option value="team_season">Team season</option>
              </Select>
            </Field>
            {scopeType !== 'org' && (
              <Field label={`${scopeType.replaceAll('_', ' ')} ID`} required>
                <Input
                  value={scopeId}
                  onChange={(event) => {
                    setScopeId(event.target.value);
                  }}
                />
              </Field>
            )}
            <Button
              type="button"
              disabled={
                busy ||
                !email ||
                roles.length === 0 ||
                (scopeType !== 'org' && !scopeId)
              }
              onClick={() => void invite()}
            >
              {busy ? 'Sending…' : 'Send invitation'}
            </Button>
          </section>
          <section aria-label="Pending invitations">
            <h2>Pending invitations</h2>
            {query.data.invitations.length === 0 && (
              <p>No pending invitations.</p>
            )}
            {query.data.invitations.map((invitation) => (
              <div className="start-credential-card" key={invitation.id}>
                <p>
                  {invitation.email} · {invitation.roles.join(', ')} ·{' '}
                  {invitation.scopeType}
                </p>
                <p>
                  Expires {new Date(invitation.expiresAt).toLocaleDateString()}
                </p>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void actOnInvitation(invitation.id, 'resend')}
                >
                  Resend
                </Button>{' '}
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void actOnInvitation(invitation.id, 'revoke')}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </section>
          <section aria-label="Members">
            <h2>Members</h2>
            {query.data.members.map((member) => (
              <MemberEditor
                key={member.accountId}
                orgId={id}
                member={member}
                ownerVersion={
                  query.data.members.find(
                    (item) => item.accountId === account.data?.id,
                  )?.version ?? null
                }
                lastOwner={
                  member.roles.some(
                    (role) =>
                      role.role === 'owner' &&
                      role.scopeType === 'org' &&
                      !role.pendingMfa,
                  ) &&
                  query.data.members.filter(
                    (item) =>
                      item.status === 'active' &&
                      item.roles.some(
                        (role) =>
                          role.role === 'owner' &&
                          role.scopeType === 'org' &&
                          !role.pendingMfa,
                      ),
                  ).length === 1
                }
              />
            ))}
          </section>
        </>
      )}
    </AuthFrame>
  );
}
