import { orgProfileSchema } from '@shared/schemas/orgs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button, Field, Input, Select } from '../ui/primitives';

type ProfileData = z.output<typeof orgProfileSchema>;
const beginUploadResponse = z.object({
  fileId: z.uuid(),
  uploadUrl: z.string(),
});
const completeUploadResponse = z.object({ id: z.uuid() });

function ProfileEditor({
  orgId,
  profile,
}: {
  orgId: string;
  profile: ProfileData;
}): React.JSX.Element {
  const client = useQueryClient();
  const [name, setName] = useState(profile.name);
  const [legalName, setLegalName] = useState(profile.legalName ?? '');
  const [timezone, setTimezone] = useState(profile.timezone);
  const [email, setEmail] = useState(profile.email ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(profile.websiteUrl ?? '');
  const [locale, setLocale] = useState(profile.defaultLocale);
  const [nonprofit, setNonprofit] = useState(profile.nonprofit);
  const [line1, setLine1] = useState(profile.address?.line1 ?? '');
  const [line2, setLine2] = useState(profile.address?.line2 ?? '');
  const [city, setCity] = useState(profile.address?.city ?? '');
  const [region, setRegion] = useState(profile.address?.region ?? '');
  const [postalCode, setPostalCode] = useState(
    profile.address?.postalCode ?? '',
  );
  const [primaryColor, setPrimaryColor] = useState(profile.brand.primaryColor);
  const [accentColor, setAccentColor] = useState(profile.brand.accentColor);
  const [logo, setLogo] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!profile.logoFileId) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetch(`/api/v1/files/${profile.logoFileId}/content`, {
      credentials: 'include',
      headers: { 'X-Athlentry-Org': orgId },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        objectUrl = URL.createObjectURL(await response.blob());
        setLogoUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [orgId, profile.logoFileId]);

  async function save(logoFileId = profile.logoFileId): Promise<void> {
    const address =
      line1.trim() || city.trim() || region.trim() || postalCode.trim()
        ? {
            line1,
            line2,
            city,
            region: region.toUpperCase(),
            postalCode,
            country: 'US' as const,
          }
        : null;
    await apiPatch(
      `/orgs/${orgId}/profile`,
      {
        name,
        legalName: legalName.trim() || null,
        timezone,
        address,
        phone: phone.trim() || null,
        email: email.trim() || null,
        websiteUrl: websiteUrl.trim() || null,
        defaultLocale: locale,
        brand: { primaryColor, accentColor },
        logoFileId,
        nonprofit,
        expectedVersion: profile.version,
      },
      orgProfileSchema,
    );
    await client.invalidateQueries({ queryKey: ['orgs', orgId, 'profile'] });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await save();
      setNotice('Organization profile saved.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Profile could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(): Promise<void> {
    if (!logo) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const upload = await apiPost(
        '/files/uploads',
        {
          purpose: 'image',
          mime: logo.type,
          bytes: logo.size,
          ownerType: 'organization',
          ownerId: orgId,
          sensitivity: 'public',
        },
        beginUploadResponse,
        undefined,
        { 'X-Athlentry-Org': orgId },
      );
      const local = upload.uploadUrl.startsWith('/');
      const response = await fetch(upload.uploadUrl, {
        method: 'PUT',
        body: logo,
        credentials: local ? 'include' : 'omit',
        headers: {
          'Content-Type': logo.type,
          ...(local ? { 'X-Athlentry-Request': '1' } : {}),
          ...(local ? { 'X-Athlentry-Org': orgId } : {}),
        },
      });
      if (!response.ok) throw new Error('Logo upload failed. Try again.');
      await apiPost(
        `/files/uploads/${upload.fileId}/complete`,
        {},
        completeUploadResponse,
        undefined,
        { 'X-Athlentry-Org': orgId },
      );
      await save(upload.fileId);
      setLogo(null);
      setNotice('Logo uploaded and organization profile saved.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Logo could not be uploaded.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/me">Account</AuthLink>}>
      <h1>Organization profile</h1>
      <p>
        Only active owners can change these settings. Confirm your identity in{' '}
        <AuthLink to="/me/security">account security</AuthLink> before saving.
      </p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      <Field label="Organization name" required>
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field label="Legal name">
        <Input
          value={legalName}
          onChange={(event) => {
            setLegalName(event.target.value);
          }}
        />
      </Field>
      <Field label="Public email">
        <Input
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </Field>
      <Field label="Public phone">
        <Input
          type="tel"
          placeholder="+13125550123"
          value={phone}
          onChange={(event) => {
            setPhone(event.target.value);
          }}
        />
      </Field>
      <Field label="Website URL">
        <Input
          type="url"
          value={websiteUrl}
          onChange={(event) => {
            setWebsiteUrl(event.target.value);
          }}
        />
      </Field>
      <Field label="Timezone" required>
        <Input
          value={timezone}
          onChange={(event) => {
            setTimezone(event.target.value);
          }}
        />
      </Field>
      <Field label="Default language">
        <Select
          value={locale}
          onChange={(event) => {
            setLocale(event.target.value as typeof locale);
          }}
        >
          <option value="en">English</option>
          <option value="es">Español</option>
        </Select>
      </Field>
      <label>
        <input
          type="checkbox"
          checked={nonprofit}
          onChange={(event) => {
            setNonprofit(event.target.checked);
          }}
        />{' '}
        Nonprofit organization
      </label>
      <fieldset>
        <legend>Postal address</legend>
        <Field label="Street address">
          <Input
            value={line1}
            onChange={(event) => {
              setLine1(event.target.value);
            }}
          />
        </Field>
        <Field label="Address line 2">
          <Input
            value={line2}
            onChange={(event) => {
              setLine2(event.target.value);
            }}
          />
        </Field>
        <Field label="City">
          <Input
            value={city}
            onChange={(event) => {
              setCity(event.target.value);
            }}
          />
        </Field>
        <Field label="State">
          <Input
            maxLength={2}
            value={region}
            onChange={(event) => {
              setRegion(event.target.value);
            }}
          />
        </Field>
        <Field label="ZIP code">
          <Input
            value={postalCode}
            onChange={(event) => {
              setPostalCode(event.target.value);
            }}
          />
        </Field>
      </fieldset>
      <fieldset>
        <legend>Brand colors</legend>
        <p>
          Colors must reach 4.5:1 contrast on white. The admin interface keeps
          its established design.
        </p>
        <Field label="Primary color">
          <Input
            type="color"
            value={primaryColor}
            onChange={(event) => {
              setPrimaryColor(event.target.value);
            }}
          />
        </Field>
        <Field label="Accent color">
          <Input
            type="color"
            value={accentColor}
            onChange={(event) => {
              setAccentColor(event.target.value);
            }}
          />
        </Field>
      </fieldset>
      <Button
        type="button"
        disabled={busy || !name.trim()}
        onClick={() => void submit()}
      >
        {busy ? 'Saving…' : 'Save profile'}
      </Button>
      <section aria-label="Organization logo">
        <h2>Logo</h2>
        {logoUrl && (
          <img alt={`${profile.name} logo`} src={logoUrl} width="120" />
        )}
        <Field label="Choose logo">
          <Input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic"
            onChange={(event) => {
              setLogo(event.target.files?.[0] ?? null);
            }}
          />
        </Field>
        <Button
          type="button"
          disabled={busy || !logo}
          onClick={() => void uploadLogo()}
        >
          Upload logo and save
        </Button>
      </section>
    </AuthFrame>
  );
}

export function Profile(): React.JSX.Element {
  const { orgId } = useParams();
  const id = String(orgId);
  const query = useQuery({
    queryKey: ['orgs', id, 'profile'],
    queryFn: () => apiGet(`/orgs/${id}/profile`, orgProfileSchema),
    enabled: Boolean(orgId),
    retry: false,
  });
  if (query.isPending)
    return (
      <AuthFrame>
        <h1>Loading profile…</h1>
      </AuthFrame>
    );
  if (query.isError)
    return (
      <AuthFrame>
        <h1>Profile unavailable</h1>
        <ErrorBox error="Check your owner access and try again." />
      </AuthFrame>
    );
  return <ProfileEditor orgId={id} profile={query.data} />;
}
