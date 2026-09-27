import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import { Button, Card, Field, Input, PageHeader, Select } from '../../ui';

import './sponsors.css';

const uuid = z.uuid();
const placementSchema = z.strictObject({
  surface: z.enum([
    'website_home',
    'program_page',
    'team_page',
    'email_footer',
  ]),
  programId: uuid.nullable().optional(),
  teamSeasonId: uuid.nullable().optional(),
});
const sponsorSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  contact: z.strictObject({
    name: z.string().optional(),
    email: z.email().optional(),
    phone: z.string().optional(),
    accountId: uuid.nullable().optional(),
  }),
  logoFileId: uuid.nullable(),
  websiteUrl: z.url().nullable(),
  tier: z.string(),
  amountCents: z.number().int().nonnegative(),
  contractStart: z.iso.date(),
  contractEnd: z.iso.date(),
  placements: z.array(placementSchema),
  invoiceId: uuid.nullable(),
  invoiceStatus: z.string().nullable(),
  invoiceBalanceCents: z.number().int().nullable(),
  status: z.enum(['prospect', 'active', 'expired', 'archived']),
  renewalNotifiedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
});
const sponsorsSchema = z.strictObject({ sponsors: z.array(sponsorSchema) });
const invoiceSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  totalCents: z.number().int(),
  status: z.string(),
});
const uploadSchema = z.strictObject({
  fileId: uuid,
  uploadUrl: z.string().min(1),
});
const completeUploadSchema = z.strictObject({ id: uuid });
type Sponsor = z.output<typeof sponsorSchema>;

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export function SponsorsConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/sponsors/orgs/${encodeURIComponent(orgId)}/sponsors`;
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactAccountId, setContactAccountId] = useState('');
  const [logo, setLogo] = useState<File | null>(null);
  const [logoFileId, setLogoFileId] = useState('');
  const [website, setWebsite] = useState('');
  const [tier, setTier] = useState('Community');
  const [amount, setAmount] = useState('');
  const [contractStart, setContractStart] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [contractEnd, setContractEnd] = useState('');
  const [surface, setSurface] =
    useState<z.output<typeof placementSchema>['surface']>('website_home');
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await apiGet(base, sponsorsSchema);
      setSponsors(result.sponsors);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sponsor records are unavailable.',
      );
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadLogo(file: File): Promise<string> {
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      throw new Error('Choose a JPEG, PNG or WebP logo up to 5 MB.');
    const upload = await apiPost(
      '/files/uploads',
      {
        purpose: 'image',
        mime: file.type,
        bytes: file.size,
        ownerType: 'organization',
        ownerId: orgId,
        sensitivity: 'public',
      },
      uploadSchema,
      undefined,
      { 'X-Athlentry-Org': orgId },
    );
    const local = upload.uploadUrl.startsWith('/');
    const result = await fetch(upload.uploadUrl, {
      method: 'PUT',
      body: file,
      credentials: local ? 'include' : 'omit',
      headers: {
        'Content-Type': file.type,
        ...(local
          ? { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': orgId }
          : {}),
      },
    });
    if (!result.ok) throw new Error('Logo upload failed.');
    await apiPost(
      `/files/uploads/${encodeURIComponent(upload.fileId)}/complete`,
      {},
      completeUploadSchema,
      undefined,
      { 'X-Athlentry-Org': orgId },
    );
    return upload.fileId;
  }

  async function createSponsor(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!contractEnd) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const attachedLogoId = logoFileId || (logo ? await uploadLogo(logo) : '');
      if (attachedLogoId && !logoFileId) setLogoFileId(attachedLogoId);
      const placement = {
        surface,
        ...(surface === 'program_page' && targetId
          ? { programId: targetId }
          : {}),
        ...(surface === 'team_page' && targetId
          ? { teamSeasonId: targetId }
          : {}),
      };
      await apiPost(
        base,
        {
          name,
          contact: {
            ...(contactName ? { name: contactName } : {}),
            ...(contactEmail ? { email: contactEmail } : {}),
            ...(contactAccountId ? { accountId: contactAccountId } : {}),
          },
          websiteUrl: website || null,
          logoFileId: attachedLogoId || null,
          tier,
          amountCents: Math.round(Number(amount) * 100),
          contractStart,
          contractEnd,
          placements: [placement],
          status: 'prospect',
        },
        sponsorSchema,
      );
      setName('');
      setContactName('');
      setContactEmail('');
      setContactAccountId('');
      setWebsite('');
      setAmount('');
      setLogo(null);
      setLogoFileId('');
      setTargetId('');
      setNotice('Sponsor record created.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sponsor record could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(
    sponsor: Sponsor,
    status: Sponsor['status'],
  ): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `${base}/${encodeURIComponent(sponsor.id)}/status`,
        { status, expectedVersion: sponsor.version },
        sponsorSchema,
      );
      setNotice(`Sponsor status changed to ${status}.`);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sponsor status could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function invoiceSponsor(sponsor: Sponsor): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/${encodeURIComponent(sponsor.id)}/invoice`,
        {
          ...(sponsor.contact.accountId
            ? { accountId: sponsor.contact.accountId }
            : {}),
        },
        invoiceSchema,
        crypto.randomUUID(),
      );
      setNotice(
        `Invoice ${result.number} created for ${money(result.totalCents)}.`,
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sponsor invoice could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-home sponsors-console">
      <PageHeader
        kicker="SPONSORSHIPS"
        title="Sponsors"
        description="Manage contract tiers, public placements, invoices and renewal dates."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Card>
        <h2>Add sponsor</h2>
        <form
          className="sponsors-console__form"
          onSubmit={(event) => {
            void createSponsor(event);
          }}
        >
          <Field label="Sponsor organization">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              maxLength={180}
              required
            />
          </Field>
          <Field label="Contact name">
            <Input
              value={contactName}
              onChange={(event) => {
                setContactName(event.target.value);
              }}
              maxLength={160}
            />
          </Field>
          <Field label="Contact email">
            <Input
              type="email"
              value={contactEmail}
              onChange={(event) => {
                setContactEmail(event.target.value);
              }}
              maxLength={254}
            />
          </Field>
          <Field
            label="Billing account ID"
            hint="Use the verified organization account that owns the sponsor invoice."
          >
            <Input
              value={contactAccountId}
              onChange={(event) => {
                setContactAccountId(event.target.value);
              }}
              pattern="[0-9a-fA-F-]{36}"
            />
          </Field>
          <Field label="Sponsor website">
            <Input
              type="url"
              value={website}
              onChange={(event) => {
                setWebsite(event.target.value);
              }}
            />
          </Field>
          <Field label="Sponsor logo" hint="JPEG, PNG or WebP up to 5 MB.">
            <Input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                setLogo(event.target.files?.[0] ?? null);
                setLogoFileId('');
              }}
            />
          </Field>
          <Field label="Sponsorship tier">
            <Input
              value={tier}
              onChange={(event) => {
                setTier(event.target.value);
              }}
              maxLength={80}
              required
            />
          </Field>
          <Field label="Contract amount in dollars">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Contract starts">
            <Input
              type="date"
              value={contractStart}
              onChange={(event) => {
                setContractStart(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Contract ends">
            <Input
              type="date"
              value={contractEnd}
              onChange={(event) => {
                setContractEnd(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Public placement">
            <Select
              value={surface}
              onChange={(event) => {
                setSurface(event.target.value as typeof surface);
              }}
            >
              <option value="website_home">Organization website</option>
              <option value="program_page">Program pages</option>
              <option value="team_page">Team pages</option>
              <option value="email_footer">Email footer</option>
            </Select>
          </Field>
          {surface === 'program_page' || surface === 'team_page' ? (
            <Field
              label={`${surface === 'program_page' ? 'Program' : 'Team season'} ID`}
            >
              <Input
                value={targetId}
                onChange={(event) => {
                  setTargetId(event.target.value);
                }}
                pattern="[0-9a-fA-F-]{36}"
                required
              />
            </Field>
          ) : null}
          <Button disabled={busy || !contractEnd}>Save sponsor</Button>
        </form>
      </Card>
      <section
        className="sponsors-console__list"
        aria-labelledby="sponsors-list-title"
      >
        <h2 id="sponsors-list-title">Sponsor contracts</h2>
        {sponsors.map((sponsor) => (
          <Card key={sponsor.id}>
            <div className="sponsors-console__row">
              <div>
                <h3>{sponsor.name}</h3>
                <p>
                  {sponsor.tier} · {money(sponsor.amountCents)} ·{' '}
                  {sponsor.contractStart} – {sponsor.contractEnd}
                </p>
                <p>
                  Status: {sponsor.status} · Invoice:{' '}
                  {sponsor.invoiceStatus ?? 'not issued'}
                </p>
                <p>
                  Placements:{' '}
                  {sponsor.placements
                    .map((item) => item.surface.replaceAll('_', ' '))
                    .join(', ') || 'none'}
                </p>
              </div>
              <div className="sponsors-console__actions">
                {sponsor.status === 'prospect' ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void setStatus(sponsor, 'active');
                    }}
                  >
                    Activate
                  </Button>
                ) : null}
                {sponsor.status === 'active' && !sponsor.invoiceId ? (
                  <Button
                    secondary
                    disabled={busy || !sponsor.contact.accountId}
                    onClick={() => {
                      void invoiceSponsor(sponsor);
                    }}
                  >
                    Issue invoice
                  </Button>
                ) : null}
                {sponsor.status === 'active' ? (
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => {
                      void setStatus(sponsor, 'expired');
                    }}
                  >
                    Mark expired
                  </Button>
                ) : null}
                {sponsor.status !== 'archived' ? (
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => {
                      void setStatus(sponsor, 'archived');
                    }}
                  >
                    Archive
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
        {sponsors.length === 0 ? <p>No sponsor records yet.</p> : null}
      </section>
    </main>
  );
}
