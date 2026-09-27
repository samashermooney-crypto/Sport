import { orgProfileSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { apiGet } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Card, Link, PageHeader } from '../ui/primitives';
import { AppShell } from '../ui/shell';

import './home.css';

export function ConsoleHome(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const profile = useQuery({
    queryKey: ['orgs', orgId, 'profile'],
    queryFn: () => apiGet(`/orgs/${String(orgId)}/profile`, orgProfileSchema),
    enabled: Boolean(orgId),
  });
  if (profile.isPending) {
    return (
      <AuthFrame>
        <h1>Loading organization…</h1>
      </AuthFrame>
    );
  }
  if (profile.isError || !orgId) {
    return (
      <AuthFrame>
        <h1>Organization workspace unavailable</h1>
        <ErrorBox error="Sign in with an active owner account and complete MFA to open this workspace." />
        <AuthLink to="/me/security">Account security</AuthLink>
      </AuthFrame>
    );
  }
  const actions = [
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
      label: 'Review audit history',
      description: 'Inspect recorded changes and protected access.',
      to: `/console/orgs/${orgId}/audit`,
    },
  ];
  const navigation = [
    { label: 'Manage', items: actions.map(({ label, to }) => ({ label, to })) },
  ];
  return (
    <AppShell
      orgName={profile.data.name}
      navigation={navigation}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}`, current: true },
        { label: 'Staff', to: `/orgs/${orgId}/staff` },
        { label: 'Profile', to: `/orgs/${orgId}/profile` },
      ]}
    >
      <main className="console-home">
        <PageHeader
          title={profile.data.name}
          kicker="ORGANIZATION HOME"
          description="Continue setting up and managing your organization."
        />
        <div className="console-home__cards">
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
