import { householdListSchema } from '@shared/schemas/households';
import {
  peopleComplianceRoleSchema,
  peopleFilterOptionsSchema,
  peopleListSchema,
  personResponseSchema,
} from '@shared/schemas/people';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../api/client';
import { useImpersonationId } from '../platform/impersonation';
import { ConsoleShell } from '../ui/ConsoleShell';
import { useToast } from '../ui/app-feedback';
import { AuthFrame, ErrorBox } from '../ui/auth';
import { ConfirmDialog } from '../ui/overlays';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Link,
  PageHeader,
  Select,
} from '../ui/primitives';

import { GuardianLinks } from './GuardianLinks';
import { PersonClaim } from './PersonClaim';
import { PersonPhoto } from './PersonPhoto';

type Person = z.output<typeof personResponseSchema>;
type ComplianceRole = z.output<typeof peopleComplianceRoleSchema>;
const complianceRoleLabels: Record<ComplianceRole, string> = {
  head_coach: 'Head coach',
  assistant_coach: 'Assistant coach',
  team_manager: 'Team manager',
  trainer: 'Trainer',
  treasurer: 'Treasurer',
  official: 'Official',
  volunteer: 'Volunteer',
  evaluator: 'Evaluator',
};
type FormValues = {
  firstName: string;
  lastName: string;
  preferredName: string;
  dateOfBirth: string;
  graduationYear: string;
  gender: Person['gender'];
  email: string;
  phoneE164: string;
  mediaConsent: Person['mediaConsent'];
};

const blank: FormValues = {
  firstName: '',
  lastName: '',
  preferredName: '',
  dateOfBirth: '',
  graduationYear: '',
  gender: 'unspecified',
  email: '',
  phoneE164: '',
  mediaConsent: 'unknown',
};

export function PersonForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Person;
  submitLabel: string;
  onSubmit: (values: FormValues) => Promise<void>;
}): React.JSX.Element {
  const notify = useToast();
  const [values, setValues] = useState<FormValues>(
    initial
      ? {
          firstName: initial.firstName,
          lastName: initial.lastName,
          preferredName: initial.preferredName ?? '',
          dateOfBirth: initial.dateOfBirth,
          graduationYear: initial.graduationYear?.toString() ?? '',
          gender: initial.gender,
          email: initial.email ?? '',
          phoneE164: initial.phoneE164 ?? '',
          mediaConsent: initial.mediaConsent,
        }
      : blank,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function set<K extends keyof FormValues>(
    field: K,
    value: FormValues[K],
  ): void {
    setValues((current) => ({ ...current, [field]: value }));
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void onSubmit(values)
          .then(() => {
            notify(initial ? 'Person saved.' : 'Person created.', 'success');
          })
          .catch((cause: unknown) => {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Person could not be saved.',
            );
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <ErrorBox error={error} />
      <Field label="First name" required>
        <Input
          required
          maxLength={120}
          value={values.firstName}
          onChange={(event) => {
            set('firstName', event.target.value);
          }}
        />
      </Field>
      <Field label="Last name" required>
        <Input
          required
          maxLength={120}
          value={values.lastName}
          onChange={(event) => {
            set('lastName', event.target.value);
          }}
        />
      </Field>
      <Field label="Preferred name">
        <Input
          maxLength={120}
          value={values.preferredName}
          onChange={(event) => {
            set('preferredName', event.target.value);
          }}
        />
      </Field>
      <Field label="Date of birth" required>
        <Input
          required
          type="date"
          value={values.dateOfBirth}
          onChange={(event) => {
            set('dateOfBirth', event.target.value);
          }}
        />
      </Field>
      <Field label="Graduation year">
        <Input
          type="number"
          min="1900"
          max="2200"
          value={values.graduationYear}
          onChange={(event) => {
            set('graduationYear', event.target.value);
          }}
        />
      </Field>
      <Field label="Gender">
        <Select
          value={values.gender}
          options={[
            { value: 'unspecified', label: 'Unspecified' },
            { value: 'female', label: 'Female' },
            { value: 'male', label: 'Male' },
            { value: 'nonbinary', label: 'Nonbinary' },
          ]}
          onChange={(event) => {
            set('gender', event.target.value as FormValues['gender']);
          }}
        />
      </Field>
      <Field label="Email">
        <Input
          type="email"
          value={values.email}
          onChange={(event) => {
            set('email', event.target.value);
          }}
        />
      </Field>
      <Field label="Phone (international format)">
        <Input
          type="tel"
          pattern="\\+[1-9][0-9]{1,14}"
          value={values.phoneE164}
          onChange={(event) => {
            set('phoneE164', event.target.value);
          }}
        />
      </Field>
      <Field label="Media consent">
        <Select
          value={values.mediaConsent}
          options={[
            { value: 'unknown', label: 'Unknown' },
            { value: 'granted', label: 'Granted' },
            { value: 'denied', label: 'Denied' },
          ]}
          onChange={(event) => {
            set(
              'mediaConsent',
              event.target.value as FormValues['mediaConsent'],
            );
          }}
        />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}

export function PeopleShell({
  orgId,
  children,
}: {
  orgId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <ConsoleShell orgId={orgId}>{children}</ConsoleShell>;
}

function requestBody(values: FormValues) {
  return {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    preferredName: values.preferredName.trim() || null,
    dateOfBirth: values.dateOfBirth,
    graduationYear:
      values.graduationYear === '' ? null : Number(values.graduationYear),
    gender: values.gender,
    email: values.email.trim() || null,
    phoneE164: values.phoneE164.trim() || null,
    mediaConsent: values.mediaConsent,
  };
}

export function PeopleList(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const impersonationId = useImpersonationId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [gender, setGender] = useState('');
  const [minAge, setMinAge] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [grade, setGrade] = useState('');
  const [householdSearch, setHouseholdSearch] = useState('');
  const [householdId, setHouseholdId] = useState('');
  const [programSearch, setProgramSearch] = useState('');
  const [programId, setProgramId] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [teamSeasonId, setTeamSeasonId] = useState('');
  const [credentialStatus, setCredentialStatus] = useState('');
  const [eligibilityRole, setEligibilityRole] = useState('');
  const [hasBalance, setHasBalance] = useState('');
  const programs = useQuery({
    queryKey: ['people-filter-programs', orgId, programSearch],
    queryFn: () =>
      apiGet(
        `/people/orgs/${String(orgId)}/filter-options?${new URLSearchParams({ kind: 'program', ...(programSearch ? { q: programSearch } : {}) })}`,
        peopleFilterOptionsSchema,
      ),
    enabled: Boolean(orgId),
  });
  const teams = useQuery({
    queryKey: ['people-filter-teams', orgId, teamSearch],
    queryFn: () =>
      apiGet(
        `/people/orgs/${String(orgId)}/filter-options?${new URLSearchParams({ kind: 'team', ...(teamSearch ? { q: teamSearch } : {}) })}`,
        peopleFilterOptionsSchema,
      ),
    enabled: Boolean(orgId),
  });
  const households = useQuery({
    queryKey: ['households', orgId, 'people-filter', householdSearch],
    queryFn: () =>
      apiGet(
        `/people/households/orgs/${String(orgId)}${householdSearch ? `?q=${encodeURIComponent(householdSearch)}` : ''}`,
        householdListSchema,
      ),
    enabled: Boolean(orgId),
  });
  const people = useQuery({
    queryKey: [
      'people',
      orgId,
      query,
      status,
      gender,
      minAge,
      maxAge,
      grade,
      householdId,
      programId,
      teamSeasonId,
      credentialStatus,
      eligibilityRole,
      hasBalance,
      cursor,
    ],
    queryFn: () =>
      apiGet(
        `/people/orgs/${String(orgId)}?${new URLSearchParams({
          ...(query ? { q: query } : {}),
          status,
          ...(gender ? { gender } : {}),
          ...(minAge ? { minAge } : {}),
          ...(maxAge ? { maxAge } : {}),
          ...(grade ? { grade } : {}),
          ...(householdId ? { householdId } : {}),
          ...(programId ? { programId } : {}),
          ...(teamSeasonId ? { teamSeasonId } : {}),
          ...(credentialStatus ? { credentialStatus } : {}),
          ...(eligibilityRole ? { eligibilityRole } : {}),
          ...(hasBalance ? { hasBalance } : {}),
          ...(cursor ? { cursor } : {}),
        })}`,
        peopleListSchema,
      ),
    enabled: Boolean(orgId),
  });
  const hasActiveFilters = Boolean(
    query.trim() ||
    status !== 'active' ||
    gender ||
    minAge ||
    maxAge ||
    grade ||
    householdId ||
    programId ||
    teamSeasonId ||
    credentialStatus ||
    eligibilityRole ||
    hasBalance,
  );
  function clearFilters(): void {
    setQuery('');
    setCursor(null);
    setStatus('active');
    setGender('');
    setMinAge('');
    setMaxAge('');
    setGrade('');
    setHouseholdSearch('');
    setHouseholdId('');
    setProgramSearch('');
    setProgramId('');
    setTeamSearch('');
    setTeamSeasonId('');
    setCredentialStatus('');
    setEligibilityRole('');
    setHasBalance('');
  }
  if (!orgId)
    return (
      <AuthFrame>
        <h1>Organization unavailable</h1>
      </AuthFrame>
    );
  return (
    <PeopleShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="PEOPLE"
          title="People"
          description="Find and manage people in this organization."
        />
        <Card>
          <h2>Find people</h2>
          <Field label="Search by name">
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Status">
            <Select
              value={status}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
              ]}
              onChange={(event) => {
                setStatus(event.target.value as 'active' | 'archived');
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Gender">
            <Select
              value={gender}
              options={[
                { value: '', label: 'Any gender' },
                { value: 'female', label: 'Female' },
                { value: 'male', label: 'Male' },
                { value: 'nonbinary', label: 'Nonbinary' },
                { value: 'unspecified', label: 'Unspecified' },
              ]}
              onChange={(event) => {
                setGender(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Minimum age">
            <Input
              type="number"
              min="0"
              max="120"
              value={minAge}
              onChange={(event) => {
                setMinAge(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Maximum age">
            <Input
              type="number"
              min="0"
              max="120"
              value={maxAge}
              onChange={(event) => {
                setMaxAge(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Grade">
            <Select
              value={grade}
              options={[
                { value: '', label: 'Any grade' },
                { value: '-1', label: 'Pre-K' },
                { value: '0', label: 'Kindergarten' },
                ...Array.from({ length: 12 }, (_, index) => ({
                  value: String(index + 1),
                  label: `Grade ${String(index + 1)}`,
                })),
              ]}
              onChange={(event) => {
                setGrade(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Find household">
            <Input
              type="search"
              value={householdSearch}
              onChange={(event) => {
                setHouseholdSearch(event.target.value);
                setHouseholdId('');
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Household">
            <Select
              value={householdId}
              options={[
                { value: '', label: 'Any household' },
                ...(households.data?.items.map((household) => ({
                  value: household.id,
                  label: household.name,
                })) ?? []),
              ]}
              onChange={(event) => {
                setHouseholdId(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Balance">
            <Select
              value={hasBalance}
              options={[
                { value: '', label: 'Any balance' },
                { value: 'true', label: 'Has outstanding balance' },
                { value: 'false', label: 'No outstanding balance' },
              ]}
              onChange={(event) => {
                setHasBalance(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Find program">
            <Input
              type="search"
              value={programSearch}
              onChange={(event) => {
                setProgramSearch(event.target.value);
                setProgramId('');
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Program">
            <Select
              value={programId}
              options={[
                { value: '', label: 'Any program' },
                ...(programs.data?.items.map((program) => ({
                  value: program.id,
                  label: program.name,
                })) ?? []),
              ]}
              onChange={(event) => {
                setProgramId(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Find team">
            <Input
              type="search"
              value={teamSearch}
              onChange={(event) => {
                setTeamSearch(event.target.value);
                setTeamSeasonId('');
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Team">
            <Select
              value={teamSeasonId}
              options={[
                { value: '', label: 'Any team' },
                ...(teams.data?.items.map((team) => ({
                  value: team.id,
                  label: team.name,
                })) ?? []),
              ]}
              onChange={(event) => {
                setTeamSeasonId(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Compliance credential status">
            <Select
              value={credentialStatus}
              options={[
                { value: '', label: 'Any credential status' },
                { value: 'pending_review', label: 'Pending review' },
                { value: 'verified', label: 'Has verified credential' },
                { value: 'rejected', label: 'Has rejected credential' },
                { value: 'expired', label: 'Has expired credential' },
                { value: 'revoked', label: 'Has revoked credential' },
                { value: 'none', label: 'No credential records' },
              ]}
              onChange={(event) => {
                setCredentialStatus(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          <Field label="Review role eligibility">
            <Select
              value={eligibilityRole}
              options={[
                { value: '', label: 'No role selected' },
                ...Object.entries(complianceRoleLabels).map(
                  ([value, label]) => ({ value, label }),
                ),
              ]}
              onChange={(event) => {
                setEligibilityRole(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          {eligibilityRole && (
            <p>
              Eligibility uses active organization requirements. Choose a
              program above to include program-specific rules.
            </p>
          )}
          {people.isPending && <p role="status">Loading people…</p>}
          {people.isError && (
            <ErrorState
              title="People could not be loaded"
              onRetry={() => {
                void people.refetch();
              }}
            >
              Your filters are still set.
            </ErrorState>
          )}
          {people.data && (
            <>
              <ul>
                {people.data.items.map((person) => (
                  <li key={person.id}>
                    <Link to={`/console/orgs/${orgId}/people/${person.id}`}>
                      {person.firstName} {person.lastName}
                    </Link>
                    {person.preferredName ? ` (${person.preferredName})` : ''}
                    {' · Age '}
                    {person.age}
                    {person.grade ? ` · ${person.grade}` : ''}
                    {person.roleEligibility && eligibilityRole ? (
                      <p>
                        <strong>
                          {
                            complianceRoleLabels[
                              eligibilityRole as ComplianceRole
                            ]
                          }
                          :{' '}
                          {person.roleEligibility.eligible
                            ? 'Eligible'
                            : 'Needs review'}
                        </strong>
                        {person.roleEligibility.missing.length > 0
                          ? ` — ${person.roleEligibility.missing.map(({ message }) => message).join(' ')}`
                          : null}
                        {person.roleEligibility.expiryDate
                          ? ` Valid through ${person.roleEligibility.expiryDate}.`
                          : null}
                        {person.roleEligibility.overridden
                          ? ' A temporary override is active.'
                          : null}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {people.data.items.length === 0 && (
                <EmptyState
                  title={
                    hasActiveFilters
                      ? 'No people match these filters'
                      : `No ${status} people`
                  }
                  action={
                    hasActiveFilters ? (
                      <Button type="button" secondary onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                >
                  {hasActiveFilters
                    ? `No ${status} people match the current search. Clear filters or adjust your search.`
                    : `No ${status} people match this search.`}
                </EmptyState>
              )}
              {people.data.nextCursor && (
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    setCursor(people.data.nextCursor);
                  }}
                >
                  Next page
                </Button>
              )}
              {cursor && (
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    setCursor(null);
                  }}
                >
                  First page
                </Button>
              )}
            </>
          )}
        </Card>
        {!impersonationId && (
          <Card>
            <h2>Add a person</h2>
            <PersonForm
              submitLabel="Create person"
              onSubmit={async (values) => {
                const person = await apiPost(
                  `/people/orgs/${orgId}`,
                  requestBody(values),
                  personResponseSchema,
                );
                await client.invalidateQueries({ queryKey: ['people', orgId] });
                void navigate(`/console/orgs/${orgId}/people/${person.id}`);
              }}
            />
          </Card>
        )}
      </main>
    </PeopleShell>
  );
}

export function PersonDetail(): React.JSX.Element {
  const { orgId, personId } = useParams<{ orgId: string; personId: string }>();
  const impersonationId = useImpersonationId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const notify = useToast();
  const person = useQuery({
    queryKey: ['people', orgId, personId],
    queryFn: () =>
      apiGet(
        `/people/orgs/${String(orgId)}/${String(personId)}`,
        personResponseSchema,
      ),
    enabled: Boolean(orgId && personId),
  });
  if (!orgId || !personId)
    return (
      <AuthFrame>
        <h1>Person unavailable</h1>
      </AuthFrame>
    );
  if (person.isPending)
    return (
      <PeopleShell orgId={orgId}>
        <main className="console-home">
          <PageHeader kicker="PERSON" title="Person" />
          <p role="status">Loading person…</p>
        </main>
      </PeopleShell>
    );
  if (person.isError)
    return (
      <PeopleShell orgId={orgId}>
        <main className="console-home">
          <PageHeader kicker="PERSON" title="Person unavailable" />
          <ErrorState
            title="Person could not be loaded"
            onRetry={() => {
              void person.refetch();
            }}
          >
            Check your access or return to the people list.
          </ErrorState>
          <Link to={`/console/orgs/${orgId}/people`}>Back to people</Link>
        </main>
      </PeopleShell>
    );
  const current = person.data;
  const personName =
    [current.firstName, current.lastName].filter(Boolean).join(' ') ||
    'This person';
  async function archivePerson(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiPost(
        `/people/orgs/${String(orgId)}/${String(personId)}/archive`,
        { expectedVersion: current.version },
        personResponseSchema,
      );
      setArchiveConfirmationOpen(false);
      await client.invalidateQueries({ queryKey: ['people', orgId] });
      notify('Person archived. Their history remains available.', 'success');
      void navigate(`/console/orgs/${String(orgId)}/people`);
    } catch (cause) {
      setArchiveConfirmationOpen(false);
      setError(cause instanceof Error ? cause.message : 'Archive failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <PeopleShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="PERSON"
          title={`${current.firstName} ${current.lastName}`}
          description={`Status: ${current.status}`}
        />
        <Link to={`/console/orgs/${orgId}/people`}>Back to people</Link>
        <ErrorBox error={error} />
        {impersonationId && (
          <Card>
            <h2>Profile</h2>
            <p>Date of birth: {current.dateOfBirth}</p>
            <p>Age: {current.age}</p>
            <p>Grade: {current.grade ?? 'Unknown'}</p>
            <p>Gender: {current.gender}</p>
            <p>Email: {current.email ?? 'None'}</p>
          </Card>
        )}
        {!impersonationId && current.status === 'active' && (
          <Card>
            <h2>Profile</h2>
            <p>
              <Link to={`/console/orgs/${orgId}/people/${personId}/medical`}>
                Medical profile
              </Link>
            </p>
            <p>
              Age: {current.age} · Grade: {current.grade ?? 'Unknown'}
            </p>
            <PersonForm
              key={current.version}
              initial={current}
              submitLabel="Save person"
              onSubmit={async (values) => {
                await apiPatch(
                  `/people/orgs/${orgId}/${personId}`,
                  {
                    ...requestBody(values),
                    expectedVersion: current.version,
                  },
                  personResponseSchema,
                );
                await client.invalidateQueries({ queryKey: ['people', orgId] });
              }}
            />
            <PersonPhoto
              orgId={orgId}
              person={current}
              onSaved={async (updated) => {
                client.setQueryData(['people', orgId, personId], updated);
                await client.invalidateQueries({ queryKey: ['people', orgId] });
              }}
            />
            <Button
              type="button"
              secondary
              disabled={busy}
              onClick={() => {
                setArchiveConfirmationOpen(true);
              }}
            >
              Archive person
            </Button>
          </Card>
        )}
        {!impersonationId && current.status === 'archived' && (
          <Card>
            <p>
              This person is archived. Their records remain available for audit
              and history.
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void apiPost(
                  `/people/orgs/${orgId}/${personId}/restore`,
                  {
                    expectedVersion: current.version,
                  },
                  personResponseSchema,
                )
                  .then(async () => {
                    await client.invalidateQueries({
                      queryKey: ['people', orgId],
                    });
                    notify('Person restored.', 'success');
                  })
                  .catch((cause: unknown) => {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : 'Restore failed.',
                    );
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Restore person
            </Button>
          </Card>
        )}
        {current.status === 'active' && (
          <GuardianLinks
            orgId={orgId}
            personId={personId}
            readOnly={Boolean(impersonationId)}
          />
        )}
        {!impersonationId &&
          current.status === 'active' &&
          current.age >= 18 && (
            <PersonClaim
              key={`${current.id}:${current.email ?? ''}`}
              orgId={orgId}
              personId={personId}
              profileEmail={current.email}
            />
          )}
        <ConfirmDialog
          title="Archive this person?"
          open={archiveConfirmationOpen}
          confirmLabel="Archive person"
          busy={busy}
          onCancel={() => {
            setArchiveConfirmationOpen(false);
          }}
          onConfirm={() => {
            void archivePerson();
          }}
        >
          {personName} will no longer appear in active lists. Their
          registrations, signatures, and audit history are retained.
        </ConfirmDialog>
      </main>
    </PeopleShell>
  );
}
