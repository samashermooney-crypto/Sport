import {
  householdListSchema,
  householdResponseSchema,
} from '@shared/schemas/households';
import { peopleListSchema } from '@shared/schemas/people';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../api/client';
import { useImpersonationId } from '../platform/impersonation';
import { useToast } from '../ui/app-feedback';
import { AuthFrame, ErrorBox } from '../ui/auth';
import { ConfirmDialog } from '../ui/overlays';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Link,
  PageHeader,
  Select,
} from '../ui/primitives';

import { PeopleShell } from './PeopleConsole';

type HouseholdMember = z.output<
  typeof householdResponseSchema
>['members'][number];

function MemberEditor({
  orgId,
  householdId,
  version,
  member,
  refresh,
}: {
  orgId: string;
  householdId: string;
  version: number;
  member: HouseholdMember;
  refresh: () => Promise<void>;
}): React.JSX.Element {
  const notify = useToast();
  const [role, setRole] = useState(member.role);
  const [primary, setPrimary] = useState(member.isPrimaryContact);
  const [receives, setReceives] = useState(member.receivesCommunications);
  const [responsible, setResponsible] = useState(member.financiallyResponsible);
  const [pickup, setPickup] = useState(member.canPickUp);
  const [livesHere, setLivesHere] = useState(member.livesHere);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removeConfirmationOpen, setRemoveConfirmationOpen] = useState(false);
  const path = `/people/households/orgs/${orgId}/${householdId}/members/${member.id}`;
  async function removeMember(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiPost(
        `${path}/remove`,
        { expectedVersion: version },
        householdResponseSchema,
      );
      setRemoveConfirmationOpen(false);
      await refresh();
      notify('Household member removed.', 'success');
    } catch (cause) {
      setRemoveConfirmationOpen(false);
      setError(
        cause instanceof Error ? cause.message : 'Member could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>
        Edit {member.firstName} {member.lastName}
      </summary>
      <ErrorBox error={error} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void apiPatch(
            path,
            {
              expectedVersion: version,
              role,
              isPrimaryContact: primary,
              receivesCommunications: receives,
              financiallyResponsible: responsible,
              canPickUp: pickup,
              livesHere,
            },
            householdResponseSchema,
          )
            .then(async () => {
              await refresh();
              notify('Household member saved.', 'success');
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Member could not be saved.',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <Field label="Household role">
          <Select
            value={role}
            options={[
              { value: 'guardian', label: 'Guardian' },
              { value: 'athlete', label: 'Athlete' },
              { value: 'other_adult', label: 'Other adult' },
              { value: 'other_child', label: 'Other child' },
            ]}
            onChange={(event) => {
              setRole(event.target.value as typeof role);
            }}
          />
        </Field>
        <label>
          <Checkbox
            checked={primary}
            onChange={(event) => {
              setPrimary(event.target.checked);
            }}
          />{' '}
          Primary contact
        </label>
        <label>
          <Checkbox
            checked={receives}
            onChange={(event) => {
              setReceives(event.target.checked);
            }}
          />{' '}
          Receives communications
        </label>
        <label>
          <Checkbox
            checked={responsible}
            onChange={(event) => {
              setResponsible(event.target.checked);
            }}
          />{' '}
          Financially responsible
        </label>
        <label>
          <Checkbox
            checked={pickup}
            onChange={(event) => {
              setPickup(event.target.checked);
            }}
          />{' '}
          Can pick up
        </label>
        <label>
          <Checkbox
            checked={livesHere}
            onChange={(event) => {
              setLivesHere(event.target.checked);
            }}
          />{' '}
          Lives here
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save member'}
        </Button>
      </form>
      <Button
        type="button"
        secondary
        disabled={busy}
        onClick={() => {
          setRemoveConfirmationOpen(true);
        }}
      >
        Remove member
      </Button>
      <ConfirmDialog
        title="Remove this household member?"
        open={removeConfirmationOpen}
        confirmLabel="Remove member"
        busy={busy}
        onCancel={() => {
          setRemoveConfirmationOpen(false);
        }}
        onConfirm={() => {
          void removeMember();
        }}
      >
        {member.firstName} {member.lastName} will be removed from this
        household. Their person and financial records are retained.
      </ConfirmDialog>
    </details>
  );
}

export function HouseholdsList(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const notify = useToast();
  const impersonation = useImpersonationId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['households', orgId, search, cursor],
    queryFn: () =>
      apiGet(
        `/people/households/orgs/${String(orgId)}?${new URLSearchParams({
          ...(search ? { q: search } : {}),
          ...(cursor ? { cursor } : {}),
        })}`,
        householdListSchema,
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
          title="Households"
          description="Manage household members and contacts."
        />
        <Card>
          <h2>Households</h2>
          <Field label="Search households">
            <Input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCursor(null);
              }}
            />
          </Field>
          {list.isPending && <p role="status">Loading households…</p>}
          {list.isError && (
            <ErrorState
              title="Households could not be loaded"
              onRetry={() => {
                void list.refetch();
              }}
            >
              Your search is still set.
            </ErrorState>
          )}
          {list.data && (
            <>
              <ul>
                {list.data.items.map((household) => (
                  <li key={household.id}>
                    <Link
                      to={`/console/orgs/${orgId}/households/${household.id}`}
                    >
                      {household.name}
                    </Link>
                    {' · '}
                    {household.members.length} members
                  </li>
                ))}
              </ul>
              {list.data.items.length === 0 && (
                <EmptyState title="No households yet">
                  Create a household to group family members, registrations, and
                  balances.
                </EmptyState>
              )}
              {list.data.nextCursor && (
                <Button
                  secondary
                  type="button"
                  onClick={() => {
                    setCursor(list.data.nextCursor);
                  }}
                >
                  Next page
                </Button>
              )}
              {cursor && (
                <Button
                  secondary
                  type="button"
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
        {!impersonation && (
          <Card>
            <h2>Create household</h2>
            <ErrorBox error={error} />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                setError('');
                void apiPost(
                  `/people/households/orgs/${orgId}`,
                  { name, address: null },
                  householdResponseSchema,
                )
                  .then(async (created) => {
                    await client.invalidateQueries({
                      queryKey: ['households', orgId],
                    });
                    void navigate(
                      `/console/orgs/${orgId}/households/${created.id}`,
                    );
                    notify('Household created.', 'success');
                  })
                  .catch((cause: unknown) => {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : 'Household could not be created.',
                    );
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              <Field label="Household name" required>
                <Input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create household'}
              </Button>
            </form>
          </Card>
        )}
      </main>
    </PeopleShell>
  );
}

export function HouseholdDetail(): React.JSX.Element {
  const { orgId, householdId } = useParams<{
    orgId: string;
    householdId: string;
  }>();
  const impersonation = useImpersonationId();
  const client = useQueryClient();
  const notify = useToast();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [address, setAddress] = useState<{
    street: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  } | null>(null);
  const [personId, setPersonId] = useState('');
  const [personSearch, setPersonSearch] = useState('');
  const [role, setRole] = useState<
    'guardian' | 'athlete' | 'other_adult' | 'other_child'
  >('athlete');
  const [primary, setPrimary] = useState(false);
  const [receives, setReceives] = useState(false);
  const [responsible, setResponsible] = useState(false);
  const [pickup, setPickup] = useState(false);
  const [livesHere, setLivesHere] = useState(true);
  const household = useQuery({
    queryKey: ['households', orgId, householdId],
    queryFn: () =>
      apiGet(
        `/people/households/orgs/${String(orgId)}/${String(householdId)}`,
        householdResponseSchema,
      ),
    enabled: Boolean(orgId && householdId),
  });
  const people = useQuery({
    queryKey: ['people', orgId, 'household-picker', personSearch],
    queryFn: () =>
      apiGet(
        `/people/orgs/${String(orgId)}?limit=100${personSearch ? `&q=${encodeURIComponent(personSearch)}` : ''}`,
        peopleListSchema,
      ),
    enabled: Boolean(orgId && !impersonation),
  });
  if (!orgId || !householdId)
    return (
      <AuthFrame>
        <h1>Household unavailable</h1>
      </AuthFrame>
    );
  if (household.isPending)
    return (
      <PeopleShell orgId={orgId}>
        <main className="console-home">
          <PageHeader kicker="HOUSEHOLD" title="Household" />
          <p role="status">Loading household…</p>
        </main>
      </PeopleShell>
    );
  if (household.isError)
    return (
      <PeopleShell orgId={orgId}>
        <main className="console-home">
          <PageHeader kicker="HOUSEHOLD" title="Household unavailable" />
          <ErrorState
            title="Household could not be loaded"
            onRetry={() => {
              void household.refetch();
            }}
          >
            Check your access or return to the household list.
          </ErrorState>
          <Link to={`/console/orgs/${orgId}/households`}>
            Back to households
          </Link>
        </main>
      </PeopleShell>
    );
  const current = household.data;
  const shownAddress = address ??
    current.address ?? {
      street: '',
      city: '',
      region: '',
      postalCode: '',
      country: 'US',
    };
  function setAddressField(
    field: keyof typeof shownAddress,
    value: string,
  ): void {
    setAddress({ ...shownAddress, [field]: value });
  }
  const available =
    people.data?.items.filter(
      (person) =>
        !current.members.some((member) => member.personId === person.id),
    ) ?? [];
  async function refresh(): Promise<void> {
    await client.invalidateQueries({ queryKey: ['households', orgId] });
  }
  return (
    <PeopleShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="HOUSEHOLD"
          title={current.name}
          description="Members, registrations and balance"
        />
        <Link to={`/console/orgs/${orgId}/households`}>Back to households</Link>
        <ErrorBox error={error} />
        <Card>
          <h2>Members</h2>
          <ul>
            {current.members.map((member) => (
              <li key={member.id}>
                <Link to={`/console/orgs/${orgId}/people/${member.personId}`}>
                  {member.firstName} {member.lastName}
                </Link>
                {' · '}
                {member.role}
                {member.isPrimaryContact ? ' · Primary contact' : ''}
                {!impersonation && (
                  <MemberEditor
                    key={`${member.id}-${String(current.version)}`}
                    orgId={orgId}
                    householdId={householdId}
                    version={current.version}
                    member={member}
                    refresh={refresh}
                  />
                )}
              </li>
            ))}
          </ul>
          {current.members.length === 0 && (
            <EmptyState title="No members yet">
              Add a person to connect this household with family records.
            </EmptyState>
          )}
        </Card>
        <Card>
          <h2>Registrations and balance</h2>
          {current.balances.map((balance) => (
            <p key={balance.currency}>
              Outstanding balance:{' '}
              {(balance.amountCents / 100).toLocaleString(undefined, {
                style: 'currency',
                currency: balance.currency,
              })}
            </p>
          ))}
          {current.balances.length === 0 && (
            <EmptyState title="No outstanding balance" />
          )}
          <ul>
            {current.registrations.map((registration) => (
              <li key={registration.id}>
                {current.members.find(
                  (member) => member.personId === registration.personId,
                )?.firstName ?? 'Member'}{' '}
                · {registration.status}
              </li>
            ))}
          </ul>
          {current.registrations.length === 0 && (
            <EmptyState title="No registrations yet" />
          )}
        </Card>
        {!impersonation && (
          <>
            <Card>
              <h2>Edit household</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setBusy(true);
                  setError('');
                  void apiPatch(
                    `/people/households/orgs/${orgId}/${householdId}`,
                    {
                      expectedVersion: current.version,
                      name: name ?? current.name,
                      address:
                        shownAddress.street || shownAddress.city
                          ? shownAddress
                          : null,
                    },
                    householdResponseSchema,
                  )
                    .then(async () => {
                      await refresh();
                      notify('Household saved.', 'success');
                    })
                    .catch((cause: unknown) => {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Household could not be saved.',
                      );
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                <Field label="Household name" required>
                  <Input
                    required
                    maxLength={160}
                    value={name ?? current.name}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </Field>
                <Field label="Street address">
                  <Input
                    value={shownAddress.street}
                    onChange={(event) => {
                      setAddressField('street', event.target.value);
                    }}
                  />
                </Field>
                <Field label="City">
                  <Input
                    value={shownAddress.city}
                    onChange={(event) => {
                      setAddressField('city', event.target.value);
                    }}
                  />
                </Field>
                <Field label="State or region">
                  <Input
                    value={shownAddress.region}
                    onChange={(event) => {
                      setAddressField('region', event.target.value);
                    }}
                  />
                </Field>
                <Field label="Postal code">
                  <Input
                    value={shownAddress.postalCode}
                    onChange={(event) => {
                      setAddressField('postalCode', event.target.value);
                    }}
                  />
                </Field>
                <Field label="Country code">
                  <Input
                    maxLength={2}
                    value={shownAddress.country}
                    onChange={(event) => {
                      setAddressField(
                        'country',
                        event.target.value.toUpperCase(),
                      );
                    }}
                  />
                </Field>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save household'}
                </Button>
              </form>
            </Card>
            <Card>
              <h2>Add member</h2>
              {people.isPending && <p role="status">Loading people…</p>}
              {people.isError && (
                <ErrorState
                  title="People could not be loaded"
                  onRetry={() => {
                    void people.refetch();
                  }}
                >
                  The household is unchanged. Try again or search later.
                </ErrorState>
              )}
              {people.data && available.length === 0 && (
                <EmptyState title="No people available to add">
                  {people.data.items.length === 0
                    ? 'Create a person in the people directory first.'
                    : 'Everyone in this result is already a household member.'}
                </EmptyState>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setBusy(true);
                  setError('');
                  void apiPost(
                    `/people/households/orgs/${orgId}/${householdId}/members`,
                    {
                      personId,
                      role,
                      isPrimaryContact: primary,
                      receivesCommunications: receives,
                      financiallyResponsible: responsible,
                      canPickUp: pickup,
                      livesHere,
                    },
                    householdResponseSchema,
                  )
                    .then(async () => {
                      setPersonId('');
                      await refresh();
                      notify('Household member added.', 'success');
                    })
                    .catch((cause: unknown) => {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Member could not be added.',
                      );
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                <Field label="Find person">
                  <Input
                    type="search"
                    value={personSearch}
                    onChange={(event) => {
                      setPersonSearch(event.target.value);
                      setPersonId('');
                    }}
                  />
                </Field>
                <Field label="Person" required>
                  <Select
                    required
                    disabled={
                      people.isPending ||
                      people.isError ||
                      available.length === 0
                    }
                    value={personId}
                    options={[
                      { value: '', label: 'Choose a person' },
                      ...available.map((person) => ({
                        value: person.id,
                        label: `${person.firstName} ${person.lastName}`,
                      })),
                    ]}
                    onChange={(event) => {
                      setPersonId(event.target.value);
                    }}
                  />
                </Field>
                <Field label="Household role">
                  <Select
                    value={role}
                    options={[
                      { value: 'guardian', label: 'Guardian' },
                      { value: 'athlete', label: 'Athlete' },
                      { value: 'other_adult', label: 'Other adult' },
                      { value: 'other_child', label: 'Other child' },
                    ]}
                    onChange={(event) => {
                      setRole(event.target.value as typeof role);
                    }}
                  />
                </Field>
                <label>
                  <Checkbox
                    checked={primary}
                    onChange={(event) => {
                      setPrimary(event.target.checked);
                    }}
                  />{' '}
                  Primary contact
                </label>
                <label>
                  <Checkbox
                    checked={receives}
                    onChange={(event) => {
                      setReceives(event.target.checked);
                    }}
                  />{' '}
                  Receives communications
                </label>
                <label>
                  <Checkbox
                    checked={responsible}
                    onChange={(event) => {
                      setResponsible(event.target.checked);
                    }}
                  />{' '}
                  Financially responsible
                </label>
                <label>
                  <Checkbox
                    checked={pickup}
                    onChange={(event) => {
                      setPickup(event.target.checked);
                    }}
                  />{' '}
                  Can pick up
                </label>
                <label>
                  <Checkbox
                    checked={livesHere}
                    onChange={(event) => {
                      setLivesHere(event.target.checked);
                    }}
                  />{' '}
                  Lives here
                </label>
                <Button type="submit" disabled={busy || !personId}>
                  {busy ? 'Adding…' : 'Add member'}
                </Button>
              </form>
            </Card>
          </>
        )}
      </main>
    </PeopleShell>
  );
}
