import { familyProfileResponseSchema } from '@shared/schemas/people';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';

import { apiGet, apiPatch } from '../api/client';
import { Card, PageHeader } from '../ui/primitives';
import { AppShell } from '../ui/shell';

import { PersonForm } from './PeopleConsole';

export function FamilyProfile(): React.JSX.Element {
  const { orgId, personId } = useParams();
  const client = useQueryClient();
  const [saved, setSaved] = useState<ReturnType<
    typeof familyProfileResponseSchema.parse
  > | null>(null);
  const profile = useQuery({
    queryKey: ['people', orgId, personId, 'family-profile'],
    queryFn: () => {
      if (!orgId || !personId) throw new Error('Missing person');
      return apiGet(
        `/people/orgs/${orgId}/${personId}/family-profile`,
        familyProfileResponseSchema,
      );
    },
    enabled: Boolean(orgId && personId),
  });
  const current = saved ?? profile.data;
  const name = current
    ? `${current.firstName} ${current.lastName}`
    : 'Family profile';
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
          title={name}
          description={
            current?.canEdit
              ? 'Keep profile details up to date for your family.'
              : 'Your linked profile details.'
          }
        />
        <p>
          <RouterLink to="/me/family">Back to family</RouterLink>
        </p>
        {profile.isPending && <p role="status">Loading profile…</p>}
        {profile.isError && (
          <Card>
            <p>Profile is unavailable.</p>
          </Card>
        )}
        {current?.canEdit && (
          <Card>
            <PersonForm
              key={`${current.id}-${String(current.version)}`}
              initial={current}
              submitLabel="Save profile"
              onSubmit={async (values) => {
                if (!orgId || !personId)
                  throw new Error('Missing person information');
                const result = await apiPatch(
                  `/people/orgs/${orgId}/${personId}/family-profile`,
                  {
                    firstName: values.firstName,
                    lastName: values.lastName,
                    preferredName: values.preferredName || null,
                    dateOfBirth: values.dateOfBirth,
                    graduationYear: values.graduationYear
                      ? Number(values.graduationYear)
                      : null,
                    gender: values.gender,
                    email: values.email || null,
                    phoneE164: values.phoneE164 || null,
                    mediaConsent: values.mediaConsent,
                    expectedVersion: current.version,
                  },
                  familyProfileResponseSchema,
                );
                setSaved(result);
                await client.invalidateQueries({
                  queryKey: ['people', 'me', 'family'],
                });
              }}
            />
            {saved && <p role="status">Profile saved.</p>}
          </Card>
        )}
        {current && !current.canEdit && (
          <Card>
            <h2>Profile details</h2>
            <p>
              {current.preferredName
                ? `${current.preferredName} (${current.firstName} ${current.lastName})`
                : `${current.firstName} ${current.lastName}`}
            </p>
            <p>Date of birth: {current.dateOfBirth}</p>
            <p>Email: {current.email ?? 'Not provided'}</p>
            <p>Phone: {current.phoneE164 ?? 'Not provided'}</p>
            <p>This profile is read-only for this account.</p>
          </Card>
        )}
      </main>
    </AppShell>
  );
}
