import { zodResolver } from '@hookform/resolvers/zod';
import { authMeResponseSchema } from '@shared/schemas/auth';
import {
  createOrgResponseSchema,
  createOrgSchema,
  orgSlugAvailabilitySchema,
  orgSlugSchema,
  sportTemplateCatalogSchema,
} from '@shared/schemas/orgs';
import type { CreateOrgInput } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiGet, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button, Field, Input, Select } from '../ui/primitives';

import './start.css';

const kinds: Array<{ value: CreateOrgInput['kind']; label: string }> = [
  { value: 'club', label: 'Club' },
  { value: 'league', label: 'Recreation league' },
  { value: 'association', label: 'Association' },
  { value: 'academy', label: 'Academy' },
  { value: 'school', label: 'School' },
  { value: 'parks_rec', label: 'Parks and recreation' },
  { value: 'tournament_operator', label: 'Tournament operator' },
  { value: 'other', label: 'Other' },
];

export function Start(): React.JSX.Element {
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    retry: false,
  });
  const sports = useQuery({
    queryKey: ['orgs', 'sport-templates'],
    queryFn: () => apiGet('/orgs/sport-templates', sportTemplateCatalogSchema),
    enabled: account.isSuccess,
  });
  const [sportSearch, setSportSearch] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [created, setCreated] = useState<{
    id: string;
    name: string;
    slug: string;
  } | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrgInput>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: {
      kind: 'club',
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
      address: { country: 'US', region: '' },
      sportKeys: [],
    },
  });
  const slug = watch('slug');
  const selectedSports = watch('sportKeys');
  const availability = useQuery({
    queryKey: ['orgs', 'slug', slug],
    queryFn: () =>
      apiGet(
        `/orgs/slug-availability?slug=${encodeURIComponent(slug)}`,
        orgSlugAvailabilitySchema,
      ),
    enabled: account.isSuccess && orgSlugSchema.safeParse(slug).success,
    retry: false,
  });

  async function submit(values: CreateOrgInput): Promise<void> {
    setSubmitError('');
    if (
      !availability.data?.available ||
      availability.data.slug !== values.slug
    ) {
      setSubmitError('Choose an available organization URL.');
      return;
    }
    try {
      const result = await apiPost('/orgs', values, createOrgResponseSchema);
      setCreated({ id: result.id, name: values.name, slug: result.slug });
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Organization creation failed.',
      );
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/me">Back to your account</AuthLink>}>
      {account.isPending && <p role="status">Checking your account…</p>}
      {account.isError && (
        <>
          <h1>Start an organization</h1>
          <p>Sign in or create an account to set up your organization.</p>
          <p>
            <AuthLink to="/">Sign in</AuthLink> ·{' '}
            <AuthLink to="/sign-up">Create an account</AuthLink>
          </p>
        </>
      )}
      {account.isSuccess && created && (
        <>
          <h1>{created.name} is ready for setup</h1>
          <p>
            Your organization URL is <strong>{created.slug}</strong>. Your owner
            role becomes active after MFA enrollment.
          </p>
          <p>
            <AuthLink to="/me/security">Set up account security</AuthLink>
          </p>
          <p>
            <AuthLink to={`/orgs/${created.id}/credentials`}>
              Review safety requirements
            </AuthLink>
          </p>
          <p>
            <AuthLink to={`/orgs/${created.id}/staff`}>
              Manage staff and invitations
            </AuthLink>
          </p>
        </>
      )}
      {account.isSuccess && !created && (
        <>
          <h1>Start an organization</h1>
          <p>
            We’ll create a private workspace with a draft season, forms, safety
            credentials, and a waiver for your review.
          </p>
          {sports.isPending && <p role="status">Loading sports…</p>}
          {sports.isError && (
            <ErrorBox error="Sports could not be loaded. Try again later." />
          )}
          {sports.isSuccess && (
            <form
              className="start-form"
              onSubmit={(event) => void handleSubmit(submit)(event)}
              noValidate
            >
              <ErrorBox error={submitError} />
              <Field
                label="Organization name"
                required
                error={errors.name?.message}
              >
                <Input {...register('name')} autoComplete="organization" />
              </Field>
              <Field
                label="Organization URL"
                required
                error={errors.slug?.message}
                hint="Lowercase letters, numbers, and hyphens."
              >
                <Input
                  {...register('slug')}
                  autoCapitalize="none"
                  autoComplete="off"
                />
              </Field>
              {orgSlugSchema.safeParse(slug).success && (
                <p role="status" className="start-slug-status">
                  {availability.isPending
                    ? 'Checking URL…'
                    : availability.data?.available
                      ? 'URL available'
                      : 'URL already taken'}
                </p>
              )}
              <Field
                label="Organization type"
                required
                error={errors.kind?.message}
              >
                <Select {...register('kind')}>
                  {kinds.map((kind) => (
                    <option value={kind.value} key={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Time zone"
                required
                error={errors.timezone?.message}
                hint="Use an IANA zone such as America/Chicago."
              >
                <Input {...register('timezone')} />
              </Field>
              <fieldset className="start-address">
                <legend>Mailing address</legend>
                <Field
                  label="Street address"
                  required
                  error={errors.address?.line1?.message}
                >
                  <Input
                    {...register('address.line1')}
                    autoComplete="address-line1"
                  />
                </Field>
                <Field label="Address line 2">
                  <Input
                    {...register('address.line2')}
                    autoComplete="address-line2"
                  />
                </Field>
                <div className="start-address-grid">
                  <Field
                    label="City"
                    required
                    error={errors.address?.city?.message}
                  >
                    <Input
                      {...register('address.city')}
                      autoComplete="address-level2"
                    />
                  </Field>
                  <Field
                    label="State"
                    required
                    error={errors.address?.region?.message}
                  >
                    <Input
                      {...register('address.region')}
                      maxLength={2}
                      autoComplete="address-level1"
                    />
                  </Field>
                  <Field
                    label="ZIP code"
                    required
                    error={errors.address?.postalCode?.message}
                  >
                    <Input
                      {...register('address.postalCode')}
                      inputMode="numeric"
                      autoComplete="postal-code"
                    />
                  </Field>
                </div>
              </fieldset>
              <fieldset className="start-sports">
                <legend>Primary sports</legend>
                <p>Select up to ten. You can add more profiles after setup.</p>
                <Input
                  aria-label="Filter sports"
                  placeholder="Find a sport"
                  value={sportSearch}
                  onChange={(event) => {
                    setSportSearch(event.target.value);
                  }}
                />
                <div className="start-sport-options">
                  {sports.data
                    .filter((sport) =>
                      sport.name
                        .toLowerCase()
                        .includes(sportSearch.toLowerCase()),
                    )
                    .map((sport) => (
                      <label key={sport.key}>
                        <input
                          type="checkbox"
                          checked={selectedSports.includes(sport.key)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...selectedSports, sport.key]
                              : selectedSports.filter(
                                  (key) => key !== sport.key,
                                );
                            setValue('sportKeys', next, {
                              shouldValidate: true,
                            });
                          }}
                        />
                        {sport.name}
                      </label>
                    ))}
                </div>
                {errors.sportKeys && (
                  <p role="alert" className="field-error">
                    Choose at least one sport.
                  </p>
                )}
              </fieldset>
              <Button
                type="submit"
                disabled={
                  isSubmitting ||
                  !availability.data?.available ||
                  selectedSports.length === 0
                }
              >
                {isSubmitting ? 'Creating…' : 'Create organization'}
              </Button>
            </form>
          )}
        </>
      )}
    </AuthFrame>
  );
}
