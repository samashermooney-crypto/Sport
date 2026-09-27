import {
  myOrganizationsSchema,
  orgWorkspaceSchema,
} from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
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
