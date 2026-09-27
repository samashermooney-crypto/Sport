import { orgProfileSchema } from '@shared/schemas/orgs';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost, apiPut } from '../../api/client';
import { Button, Card, Field, Input, PageHeader, Textarea } from '../../ui';

import './fundraising.css';

const uuid = z.uuid();
const campaignSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  goalCents: z.number().int(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  teamSeasonId: uuid.nullable(),
  descriptionHtml: z.string(),
  status: z.enum(['draft', 'published', 'ended', 'archived']),
  totalRaisedCents: z.number().int().nonnegative(),
  donorCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
const campaignsSchema = z.strictObject({ campaigns: z.array(campaignSchema) });
const settingsSchema = z.strictObject({
  isNonprofit: z.boolean(),
  einLastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  showFullEin: z.boolean(),
  version: z.number().int().positive(),
});
const statementSchema = z.strictObject({
  year: z.number().int(),
  orgName: z.string(),
  donationCount: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  receiptNumbers: z.array(z.string()),
});
const campaignStatusSchema = z.strictObject({
  status: z.enum(['draft', 'published', 'ended', 'archived']),
  version: z.number().int().positive(),
});
type Campaign = z.output<typeof campaignSchema>;
type Settings = z.output<typeof settingsSchema>;

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export function FundraisingConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/fundraising/orgs/${encodeURIComponent(orgId)}`;
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [orgSlug, setOrgSlug] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [goal, setGoal] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [description, setDescription] = useState('');
  const [teamSeasonId, setTeamSeasonId] = useState('');
  const [isNonprofit, setIsNonprofit] = useState(false);
  const [ein, setEin] = useState('');
  const [showFullEin, setShowFullEin] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [statement, setStatement] = useState<z.output<
    typeof statementSchema
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [campaignResult, settingResult, profile] = await Promise.all([
        apiGet(`${base}/campaigns`, campaignsSchema),
        apiGet(`${base}/settings`, settingsSchema),
        apiGet(`/orgs/${encodeURIComponent(orgId)}/profile`, orgProfileSchema),
      ]);
      setCampaigns(campaignResult.campaigns);
      setOrgSlug(profile.slug);
      setSettings(settingResult);
      setIsNonprofit(settingResult.isNonprofit);
      setShowFullEin(settingResult.showFullEin);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Fundraising data is unavailable.',
      );
    }
  }, [base, orgId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createCampaign(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!startsAt) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/campaigns`,
        {
          name,
          slug,
          goalCents: Math.round(Number(goal) * 100),
          startsAt: new Date(startsAt).toISOString(),
          descriptionHtml: description,
          teamSeasonId: teamSeasonId || null,
          showDonorNames: true,
        },
        campaignSchema,
      );
      setName('');
      setSlug('');
      setGoal('');
      setDescription('');
      setTeamSeasonId('');
      setNotice('Fundraising campaign created as a draft.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Campaign could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(
    campaign: Campaign,
    status: 'published' | 'ended' | 'archived',
  ): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `${base}/campaigns/${encodeURIComponent(campaign.id)}/status`,
        { status, expectedVersion: campaign.version },
        campaignStatusSchema,
      );
      setNotice(`Campaign ${status}.`);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Campaign status could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPut(
        `${base}/settings`,
        {
          isNonprofit,
          ...(ein.trim() ? { ein: ein.replaceAll('-', '') } : {}),
          showFullEin,
          ...(settings ? { expectedVersion: settings.version } : {}),
        },
        settingsSchema,
      );
      setSettings(result);
      setEin('');
      setNotice('Donation acknowledgment settings saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Acknowledgment settings could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadStatement(): Promise<void> {
    setError('');
    setStatement(null);
    try {
      setStatement(
        await apiGet(
          `${base}/donor-statements/${encodeURIComponent(year)}`,
          statementSchema,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Donor statement is unavailable.',
      );
    }
  }

  return (
    <main className="console-home fundraising-console">
      <PageHeader
        kicker="FUNDRAISING"
        title="Campaigns and donations"
        description="Create public campaigns, monitor donations and manage nonprofit receipt details."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Card>
        <h2>New campaign</h2>
        <form
          className="fundraising-console__form"
          onSubmit={(event) => {
            void createCampaign(event);
          }}
        >
          <Field label="Campaign name">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              maxLength={160}
              required
            />
          </Field>
          <Field label="Public URL slug">
            <Input
              value={slug}
              onChange={(event) => {
                setSlug(
                  event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
                );
              }}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              maxLength={120}
              required
            />
          </Field>
          <Field label="Goal in dollars">
            <Input
              type="number"
              min="1"
              step="0.01"
              value={goal}
              onChange={(event) => {
                setGoal(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Campaign starts">
            <Input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => {
                setStartsAt(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Team season ID (optional)">
            <Input
              value={teamSeasonId}
              onChange={(event) => {
                setTeamSeasonId(event.target.value);
              }}
              pattern="[0-9a-fA-F-]{36}"
            />
          </Field>
          <Field label="Campaign description">
            <Textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              maxLength={12000}
            />
          </Field>
          <Button disabled={busy || !startsAt}>Create draft campaign</Button>
        </form>
      </Card>
      <section
        className="fundraising-console__campaigns"
        aria-labelledby="campaigns-title"
      >
        <h2 id="campaigns-title">Campaign performance</h2>
        {campaigns.map((campaign) => (
          <Card key={campaign.id}>
            <div className="fundraising-console__campaign-heading">
              <div>
                <h3>{campaign.name}</h3>
                <p>
                  {campaign.status} · {money(campaign.totalRaisedCents)} of{' '}
                  {money(campaign.goalCents)} · {campaign.donorCount} donors
                </p>
                <progress
                  aria-label={`${campaign.name} fundraising progress`}
                  max={campaign.goalCents}
                  value={Math.min(
                    campaign.totalRaisedCents,
                    campaign.goalCents,
                  )}
                />
              </div>
              <div className="fundraising-console__actions">
                {campaign.status === 'draft' ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void setStatus(campaign, 'published');
                    }}
                  >
                    Publish
                  </Button>
                ) : null}
                {campaign.status === 'published' ? (
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => {
                      void setStatus(campaign, 'ended');
                    }}
                  >
                    End
                  </Button>
                ) : null}
                {campaign.status !== 'archived' ? (
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => {
                      void setStatus(campaign, 'archived');
                    }}
                  >
                    Archive
                  </Button>
                ) : null}
                {orgSlug ? (
                  <a
                    href={`/site/${encodeURIComponent(orgSlug)}/fundraisers/${encodeURIComponent(campaign.slug)}`}
                  >
                    Public campaign
                  </a>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
        {campaigns.length === 0 ? <p>No campaigns yet.</p> : null}
      </section>
      <Card>
        <h2>Donation acknowledgment</h2>
        <p>
          {settings?.einLastFour
            ? `Saved nonprofit EIN ending in ${settings.einLastFour}.`
            : 'No EIN is stored.'}
        </p>
        <form
          className="fundraising-console__form"
          onSubmit={(event) => {
            void saveSettings(event);
          }}
        >
          <label className="fundraising-console__check">
            <input
              type="checkbox"
              checked={isNonprofit}
              onChange={(event) => {
                setIsNonprofit(event.target.checked);
              }}
            />{' '}
            Organization is a nonprofit
          </label>
          {isNonprofit ? (
            <Field
              label="Nine-digit EIN"
              hint="Stored encrypted. It will not be shown again after saving."
            >
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={ein}
                onChange={(event) => {
                  setEin(event.target.value);
                }}
                pattern="[0-9-]{9,10}"
                maxLength={10}
              />
            </Field>
          ) : null}
          <label className="fundraising-console__check">
            <input
              type="checkbox"
              checked={showFullEin}
              onChange={(event) => {
                setShowFullEin(event.target.checked);
              }}
            />{' '}
            Show full EIN on donor receipts
          </label>
          <Button disabled={busy}>Save acknowledgment settings</Button>
        </form>
      </Card>
      <Card>
        <h2>Year-end donor statement</h2>
        <div className="fundraising-console__statement">
          <Field label="Tax year">
            <Input
              type="number"
              min="2000"
              max="2100"
              value={year}
              onChange={(event) => {
                setYear(event.target.value);
              }}
            />
          </Field>
          <Button
            secondary
            onClick={() => {
              void loadStatement();
            }}
          >
            Load statement
          </Button>
        </div>
        {statement ? (
          <div role="status">
            <p>
              {statement.orgName} · {statement.year}:{' '}
              {money(statement.totalCents)} across {statement.donationCount}{' '}
              donations.
            </p>
            <p>
              Receipt numbers: {statement.receiptNumbers.join(', ') || 'None'}
            </p>
          </div>
        ) : null}
      </Card>
    </main>
  );
}
