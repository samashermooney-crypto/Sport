import {
  myOrganizationsSchema,
  orgWorkspaceSchema,
} from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';

import { apiGet } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Card, Link, PageHeader, Select } from '../ui/primitives';
import { AppShell } from '../ui/shell';

import './home.css';

export function ConsoleHome(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  const organizations = useQuery({
    queryKey: ['orgs', 'mine'],
    queryFn: () => apiGet('/orgs/mine', myOrganizationsSchema),
  });
  if (workspace.isPending) {
    return (
      <AuthFrame>
        <h1>Loading organization…</h1>
      </AuthFrame>
    );
  }
  if (workspace.isError || !orgId) {
    return (
      <AuthFrame>
        <h1>Organization workspace unavailable</h1>
        <ErrorBox error="Sign in with an active organization membership to open this workspace." />
        <AuthLink to="/me/security">Account security</AuthLink>
      </AuthFrame>
    );
  }
  const manageActions = [
    {
      label: 'Manage people',
      description: 'Create, find and update people in your organization.',
      to: `/console/orgs/${orgId}/people`,
    },
    {
      label: 'Manage households',
      description: 'Create households and link people to them.',
      to: `/console/orgs/${orgId}/households`,
    },
    {
      label: 'Review safety requirements',
      description: 'Edit the credential checks your organization uses.',
      to: `/orgs/${orgId}/credentials`,
    },
    {
      label: 'Manage staff and invitations',
      description: 'Invite staff and control their roles.',
      to: `/orgs/${orgId}/staff`,
    },
    {
      label: 'Edit organization profile and logo',
      description: 'Keep contact details and public branding current.',
      to: `/orgs/${orgId}/profile`,
    },
    {
      label: 'Open safety center',
      description:
        'Review credentials, injuries, incidents and background checks.',
      to: `/console/safety/${orgId}`,
    },
    {
      label: 'Review audit history',
      description: 'Inspect recorded changes and protected access.',
      to: `/console/orgs/${orgId}/audit`,
    },
  ];
  const actions = [
    ...(workspace.data.canManage ? manageActions.slice(0, 6) : []),
    ...(workspace.data.canAudit && manageActions[6] ? [manageActions[6]] : []),
  ];
  const navigation = [
    {
      label: 'Manage',
      items: [
        ...actions.map(({ label, to }) => ({ label, to })),
        { label: 'Account', to: '/me' },
      ],
    },
  ];
  return (
    <AppShell
      orgName={workspace.data.name}
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
      navigation={navigation}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}`, current: true },
        ...(workspace.data.canManage
          ? [
              { label: 'Staff', to: `/orgs/${orgId}/staff` },
              { label: 'Profile', to: `/orgs/${orgId}/profile` },
            ]
          : []),
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home">
        <PageHeader
          title={workspace.data.name}
          kicker="ORGANIZATION HOME"
          description="Continue setting up and managing your organization."
        />
        <div className="console-home__cards">
          {actions.length === 0 && (
            <Card>
              <h2>Account security</h2>
              <p>Update your sign-in and security settings.</p>
              <Link to="/me/security">Open account security</Link>
            </Card>
          )}
          {actions.map((action) => (
            <Card key={action.to}>
              <h2>{action.label}</h2>
              <p>{action.description}</p>
              <Link to={action.to}>{action.label}</Link>
            </Card>
          ))}
        </div>
      </main>
    </AppShell>
  );
}
