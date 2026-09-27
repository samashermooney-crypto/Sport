import { familyResponseSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';

import { apiGet } from '../api/client';
import { AuthLink } from '../ui/auth';
import { Card, PageHeader } from '../ui/primitives';
import { AppShell } from '../ui/shell';

export function FamilyHome(): React.JSX.Element {
  const family = useQuery({
    queryKey: ['people', 'me', 'family'],
    queryFn: () => apiGet('/people/me/family', familyResponseSchema),
  });
  return (
    <AppShell
      orgName="Athlentry"
      navigation={[
        {
          label: 'Family',
          items: [
            { label: 'Family', to: '/me/family' },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Family', to: '/me/family' },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="FAMILY"
          title="Your family"
          description="People linked to your account across organizations"
        />
        {family.isPending && <p role="status">Loading family…</p>}
        {family.isError && (
          <Card>
            <p>Family details are unavailable.</p>
          </Card>
        )}
        {family.data?.organizations.length === 0 && (
          <Card>
            <p>No family profiles are linked to this account.</p>
          </Card>
        )}
        {family.data?.organizations.map((org) => (
          <Card key={org.orgId}>
            <h2>{org.orgName}</h2>
            <ul>
              {org.people.map((person) => (
                <li key={person.personId}>
                  {person.firstName} {person.lastName} · Age {person.age} ·{' '}
                  {person.relationship === 'guardian'
                    ? 'Guardian access'
                    : 'Your profile'}
                </li>
              ))}
            </ul>
          </Card>
        ))}
        <AuthLink to="/me">Account</AuthLink>
      </main>
    </AppShell>
  );
}
