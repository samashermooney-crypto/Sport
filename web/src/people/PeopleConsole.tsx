import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { peopleListSchema, personResponseSchema } from '@shared/schemas/people';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../api/client';
import { useImpersonationId } from '../platform/impersonation';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import {
  Button,
  Card,
  Field,
  Input,
  Link,
  PageHeader,
  Select,
} from '../ui/primitives';
import { AppShell } from '../ui/shell';

type Person = z.output<typeof personResponseSchema>;
type FormValues = {
  firstName: string;
  lastName: string;
  preferredName: string;
  dateOfBirth: string;
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
  gender: 'unspecified',
  email: '',
  phoneE164: '',
  mediaConsent: 'unknown',
};

function PersonForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Person;
  submitLabel: string;
  onSubmit: (values: FormValues) => Promise<void>;
}): React.JSX.Element {
  const [values, setValues] = useState<FormValues>(
    initial
      ? {
          firstName: initial.firstName,
          lastName: initial.lastName,
          preferredName: initial.preferredName ?? '',
          dateOfBirth: initial.dateOfBirth,
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

function PeopleShell({
  orgId,
  children,
}: {
  orgId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const impersonationId = useImpersonationId();
  const home = `/console/orgs/${orgId}`;
  const people = `${home}/people`;
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
    enabled: !impersonationId,
  });
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            ...(!impersonationId ? [{ label: 'Home', to: home }] : []),
            { label: 'People', to: people },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        ...(!impersonationId ? [{ label: 'Home', to: home }] : []),
        { label: 'People', to: people },
        { label: 'Account', to: '/me' },
      ]}
    >
      {children}
    </AppShell>
  );
}

function requestBody(values: FormValues) {
  return {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    preferredName: values.preferredName.trim() || null,
    dateOfBirth: values.dateOfBirth,
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
  const people = useQuery({
    queryKey: ['people', orgId, query, status, cursor],
    queryFn: () =>
      apiGet(
        `/people/orgs/${String(orgId)}?${new URLSearchParams({
          ...(query ? { q: query } : {}),
          status,
          ...(cursor ? { cursor } : {}),
        })}`,
        peopleListSchema,
      ),
    enabled: Boolean(orgId),
  });
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
          {people.isPending && <p role="status">Loading people…</p>}
          {people.isError && <ErrorBox error="People could not be loaded." />}
          {people.data && (
            <>
              <ul>
                {people.data.items.map((person) => (
                  <li key={person.id}>
                    <Link to={`/console/orgs/${orgId}/people/${person.id}`}>
                      {person.firstName} {person.lastName}
                    </Link>
                    {person.preferredName ? ` (${person.preferredName})` : ''}
                  </li>
                ))}
              </ul>
              {people.data.items.length === 0 && (
                <p>No {status} people match this search.</p>
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
      <AuthFrame>
        <h1>Loading person…</h1>
      </AuthFrame>
    );
  if (person.isError)
    return (
      <AuthFrame>
        <h1>Person unavailable</h1>
        <AuthLink to={`/console/orgs/${orgId}/people`}>Back to people</AuthLink>
      </AuthFrame>
    );
  const current = person.data;
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
            <p>Gender: {current.gender}</p>
            <p>Email: {current.email ?? 'None'}</p>
          </Card>
        )}
        {!impersonationId && current.status === 'active' && (
          <Card>
            <h2>Profile</h2>
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
            <Button
              type="button"
              secondary
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Archive ${current.firstName} ${current.lastName}?`,
                  )
                )
                  return;
                setBusy(true);
                setError('');
                void apiPost(
                  `/people/orgs/${orgId}/${personId}/archive`,
                  {
                    expectedVersion: current.version,
                  },
                  personResponseSchema,
                )
                  .then(async () => {
                    await client.invalidateQueries({
                      queryKey: ['people', orgId],
                    });
                    void navigate(`/console/orgs/${orgId}/people`);
                  })
                  .catch((cause: unknown) => {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : 'Archive failed.',
                    );
                  })
                  .finally(() => {
                    setBusy(false);
                  });
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
      </main>
    </PeopleShell>
  );
}
