import { householdListSchema } from '@shared/schemas/households';
import {
  myOrganizationsSchema,
  orgWorkspaceSchema,
} from '@shared/schemas/orgs';
import { peopleListSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { apiGet } from '../api/client';
import { useImpersonationId } from '../platform/impersonation';

import { Select } from './primitives';
import { AppShell } from './shell';

export function ConsoleShell({
  orgId,
  children,
}: PropsWithChildren<{ orgId: string }>): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const impersonationId = useImpersonationId();
  const [searchQuery, setSearchQuery] = useState('');
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  const organizations = useQuery({
    queryKey: ['orgs', 'mine'],
    queryFn: () => apiGet('/orgs/mine', myOrganizationsSchema),
    enabled: !impersonationId,
  });
  const peopleSearch = useQuery({
    queryKey: ['people', orgId, 'global-search', searchQuery],
    queryFn: () =>
      apiGet(
        `/people/orgs/${encodeURIComponent(orgId)}?${new URLSearchParams({ q: searchQuery, status: 'active', limit: '8' })}`,
        peopleListSchema,
      ),
    enabled: Boolean(orgId && searchQuery),
  });
  const householdSearch = useQuery({
    queryKey: ['households', orgId, 'global-search', searchQuery],
    queryFn: () =>
      apiGet(
        `/people/households/orgs/${encodeURIComponent(orgId)}?${new URLSearchParams({ q: searchQuery })}`,
        householdListSchema,
      ),
    enabled: Boolean(orgId && searchQuery),
  });
  const globalSearchResults = [
    ...(peopleSearch.data?.items.map((person) => ({
      label: `${person.firstName} ${person.lastName}`,
      to: `/console/orgs/${orgId}/people/${person.id}`,
    })) ?? []),
    ...(householdSearch.data?.items.map((household) => ({
      label: household.name,
      to: `/console/orgs/${orgId}/households/${household.id}`,
    })) ?? []),
  ];
  const home = `/console/orgs/${orgId}`;
  const links = {
    Home: home,
    People: `${home}/people`,
    Households: `${home}/households`,
    Forms: `${home}/forms`,
    Waivers: `${home}/waivers`,
    Imports: `${home}/imports`,
    Schedule: `${home}/schedule`,
    Messages: `${home}/messages`,
    Safety: `/console/safety/${orgId}`,
    Classes: `${home}/classes`,
    Federation: `/console/federation/${orgId}`,
    Profile: `/orgs/${orgId}/profile`,
    Staff: `/orgs/${orgId}/staff`,
    Credentials: `/orgs/${orgId}/credentials`,
    Payments: `${home}/money/connect`,
    Audit: `${home}/audit`,
    Account: '/me',
  } as const;
  const item = (label: keyof typeof links) => ({
    label,
    to: links[label],
    current:
      location.pathname === links[label] ||
      (label !== 'Home' && location.pathname.startsWith(`${links[label]}/`)),
  });
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      orgSwitcher={
        organizations.data && organizations.data.length > 1 ? (
          <Select
            aria-label="Switch organization"
            value={orgId}
            options={organizations.data.map((organization) => ({
              value: organization.id,
              label: organization.name,
            }))}
            onChange={(event) => {
              void navigate(`/console/orgs/${event.target.value}`);
            }}
          />
        ) : undefined
      }
      navigation={[
        {
          label: 'Manage',
          items: [
            ...(!impersonationId ? [item('Home')] : []),
            item('People'),
            item('Households'),
            item('Forms'),
            item('Waivers'),
            item('Imports'),
          ],
        },
        {
          label: 'Operations',
          items: [
            item('Schedule'),
            item('Messages'),
            item('Safety'),
            item('Classes'),
            item('Federation'),
          ],
        },
        {
          label: 'Organization',
          items: [
            item('Profile'),
            item('Staff'),
            item('Credentials'),
            item('Payments'),
            item('Audit'),
          ],
        },
        { label: 'Account', items: [item('Account')] },
      ]}
      mobileTabs={[
        ...(!impersonationId ? [item('Home')] : []),
        item('People'),
        item('Schedule'),
        item('Messages'),
        item('Account'),
      ]}
      onGlobalSearch={setSearchQuery}
      searchResults={globalSearchResults}
      searchLoading={peopleSearch.isFetching || householdSearch.isFetching}
      searchError={
        peopleSearch.isError || householdSearch.isError
          ? 'People search is unavailable. Try again.'
          : undefined
      }
    >
      {children}
    </AppShell>
  );
}

export function ConsoleRouteShell({
  children,
}: PropsWithChildren): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <ConsoleShell orgId={orgId}>{children}</ConsoleShell>
  ) : (
    <>{children}</>
  );
}
