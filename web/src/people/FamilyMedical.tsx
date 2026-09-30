import { medicalResponseSchema } from '@shared/schemas/medical';
import type { MedicalUpdate } from '@shared/schemas/medical';
import { familyResponseSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useLocation, useParams } from 'react-router';
import type { z } from 'zod';

import { apiGet, apiPatch } from '../api/client';
import { ErrorBox } from '../ui/auth';
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Textarea,
} from '../ui/primitives';
import { AppShell } from '../ui/shell';

import { AthleteAccess } from './AthleteAccess';
import { EmergencyContacts } from './EmergencyContacts';

type Profile = z.output<typeof medicalResponseSchema>;
type Values = Omit<MedicalUpdate, 'expectedVersion' | 'allergyFlags'> & {
  allergyFlags: string;
};

function MedicalForm({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: (profile: Profile) => void;
}): React.JSX.Element {
  const [values, setValues] = useState<Values>({
    allergies: profile.allergies,
    allergyFlags: profile.allergyFlags.join(', '),
    conditions: profile.conditions,
    medications: profile.medications,
    physicianName: profile.physicianName,
    physicianPhone: profile.physicianPhone,
    insuranceCarrier: profile.insuranceCarrier,
    insurancePolicy: profile.insurancePolicy,
    notes: profile.notes,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { orgId, personId } = useParams();
  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }
  const textFields = [
    ['Allergies', 'allergies'],
    ['Conditions', 'conditions'],
    ['Medications', 'medications'],
    ['Notes', 'notes'],
  ] as const;
  const shortFields = [
    ['Physician name', 'physicianName'],
    ['Physician phone', 'physicianPhone'],
    ['Insurance carrier', 'insuranceCarrier'],
    ['Insurance policy', 'insurancePolicy'],
  ] as const;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!orgId || !personId) return;
        setBusy(true);
        setError('');
        void apiPatch(
          `/people/orgs/${orgId}/${personId}/medical`,
          {
            ...values,
            allergyFlags: values.allergyFlags
              .split(',')
              .map((flag) => flag.trim().toLowerCase().replaceAll(' ', '_'))
              .filter(Boolean),
            expectedVersion: profile.version,
          },
          medicalResponseSchema,
        )
          .then(onSaved)
          .catch((cause: unknown) => {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Medical profile could not be saved.',
            );
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <ErrorBox error={error} />
      <Field label="Allergy flags (comma separated codes)">
        <Input
          value={values.allergyFlags}
          onChange={(event) => {
            set('allergyFlags', event.target.value);
          }}
          maxLength={1200}
        />
      </Field>
      {textFields.map(([label, key]) => (
        <Field label={label} key={key}>
          <Textarea
            value={values[key] ?? ''}
            onChange={(event) => {
              set(key, event.target.value || null);
            }}
            maxLength={4000}
          />
        </Field>
      ))}
      {shortFields.map(([label, key]) => (
        <Field label={label} key={key}>
          <Input
            value={values[key] ?? ''}
            onChange={(event) => {
              set(key, event.target.value || null);
            }}
            maxLength={200}
          />
        </Field>
      ))}
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save medical profile'}
      </Button>
    </form>
  );
}

export function FamilyMedical(): React.JSX.Element {
  const { orgId, personId } = useParams();
  const location = useLocation();
  const staffView = location.pathname.startsWith('/console/');
  const backTo = staffView
    ? `/console/orgs/${String(orgId)}/people/${String(personId)}`
    : '/me/family';
  const [saved, setSaved] = useState<Profile | null>(null);
  const profile = useQuery({
    queryKey: ['people', orgId, personId, 'medical'],
    queryFn: () => {
      if (!orgId || !personId) throw new Error('Missing person');
      return apiGet(
        `/people/orgs/${orgId}/${personId}/medical`,
        medicalResponseSchema,
      );
    },
    enabled: Boolean(orgId && personId),
  });
  const family = useQuery({
    queryKey: ['people', 'me', 'family'],
    queryFn: () => apiGet('/people/me/family', familyResponseSchema),
    enabled: !staffView && Boolean(orgId && personId),
  });
  const relationship = family.data?.organizations
    .find((organization) => organization.orgId === orgId)
    ?.people.find((person) => person.personId === personId)?.relationship;
  const current = saved ?? profile.data;
  return (
    <AppShell
      orgName="Athlentry"
      navigation={[
        {
          label: staffView ? 'People' : 'Family',
          items: [{ label: staffView ? 'Person' : 'Family', to: backTo }],
        },
      ]}
      mobileTabs={[
        { label: staffView ? 'Person' : 'Family', to: backTo },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker={staffView ? 'PERSON' : 'FAMILY'}
          title="Medical profile"
          description="Medical details are encrypted and each read is recorded."
        />
        <RouterLink to={backTo}>
          {staffView ? 'Back to person' : 'Back to family'}
        </RouterLink>
        {profile.isPending && <p role="status">Loading medical profile…</p>}
        {profile.isError && (
          <Card>
            <p>Medical profile is unavailable.</p>
          </Card>
        )}
        {current && (
          <Card>
            {current.canEdit ? (
              <MedicalForm
                key={current.version}
                profile={current}
                onSaved={(next) => {
                  setSaved(next);
                }}
              />
            ) : (
              <div>
                <p>
                  Allergy flags:{' '}
                  {current.allergyFlags.join(', ') || 'None on file'}
                </p>
                {current.visibility === 'full' && (
                  <p>Allergies: {current.allergies || 'None on file'}</p>
                )}
              </div>
            )}
            {saved && <p role="status">Medical profile saved.</p>}
          </Card>
        )}
        {current && orgId && personId && (
          <EmergencyContacts orgId={orgId} personId={personId} />
        )}
        {current &&
          !staffView &&
          relationship === 'guardian' &&
          orgId &&
          personId && <AthleteAccess orgId={orgId} personId={personId} />}
      </main>
    </AppShell>
  );
}
