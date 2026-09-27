import { authCaptchaConfigResponseSchema } from '@shared/schemas/auth';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { TurnstileWidget } from '../../auth/TurnstileWidget';
import { Button, Card, Field, Input, Textarea } from '../../ui';

import './public-fundraiser.css';

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
  orgId: uuid,
  donorWall: z.array(
    z.strictObject({
      donorName: z.string(),
      amountCents: z.number().int().positive(),
      paidAt: z.iso.datetime(),
    }),
  ),
});
const checkoutSchema = z.strictObject({
  donationId: uuid,
  checkoutUrl: z.url(),
  receiptNumber: z.string(),
  amountCents: z.number().int().positive(),
});
type Campaign = z.output<typeof campaignSchema>;

const copy = {
  en: {
    loading: 'Loading this fundraiser…',
    missing: 'This fundraising campaign is unavailable.',
    donate: 'Make a donation',
    name: 'Your name',
    email: 'Email address',
    amount: 'Donation amount in dollars',
    anonymous: 'Keep my donation anonymous',
    dedication: 'Dedication (optional)',
    challenge: 'Complete the bot protection challenge before donating.',
    submit: 'Continue to secure checkout',
    progress: 'Raised',
    donors: 'Donors',
    success: 'Donation complete. Thank you for supporting this team.',
  },
  es: {
    loading: 'Cargando esta campaña…',
    missing: 'Esta campaña de recaudación no está disponible.',
    donate: 'Hacer una donación',
    name: 'Tu nombre',
    email: 'Correo electrónico',
    amount: 'Monto de la donación en dólares',
    anonymous: 'Mantener mi donación anónima',
    dedication: 'Dedicatoria (opcional)',
    challenge: 'Completa la verificación antes de donar.',
    submit: 'Continuar al pago seguro',
    progress: 'Recaudado',
    donors: 'Donantes',
    success: 'Donación completada. Gracias por apoyar a este equipo.',
  },
} as const;

function formatMoney(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'es' ? 'es-US' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function descriptionText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function PublicFundraiser({
  orgSlug,
  campaignSlug,
}: {
  orgSlug: string;
  campaignSlug: string;
}): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const locale = searchParams.get('lang') === 'es' ? 'es' : 'en';
  const labels = copy[locale];
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [captcha, setCaptcha] = useState<z.output<
    typeof authCaptchaConfigResponseSchema
  > | null>(null);
  const [donorName, setDonorName] = useState('');
  const [donorEmail, setDonorEmail] = useState('');
  const [amount, setAmount] = useState('25.00');
  const [anonymous, setAnonymous] = useState(true);
  const [dedication, setDedication] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [challengeError, setChallengeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const handleCaptchaToken = useCallback((token: string) => {
    setCaptchaToken(token);
    setChallengeError('');
  }, []);
  const handleCaptchaError = useCallback((message: string) => {
    setChallengeError(message);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [campaignResult, captchaResult] = await Promise.all([
        apiGet(
          `/fundraising/public/orgs/${encodeURIComponent(orgSlug)}/campaigns/${encodeURIComponent(campaignSlug)}`,
          campaignSchema,
        ),
        apiGet('/auth/captcha-config', authCaptchaConfigResponseSchema),
      ]);
      setCampaign(campaignResult);
      setCaptcha(captchaResult);
      if (captchaResult.mode === 'preview') setCaptchaToken('local-preview');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.missing);
    }
  }, [campaignSlug, labels.missing, orgSlug]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function donate(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!captchaToken) {
      setChallengeError(labels.challenge);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await apiPost(
        `/fundraising/public/orgs/${encodeURIComponent(orgSlug)}/campaigns/${encodeURIComponent(campaignSlug)}/donations`,
        {
          donorName,
          donorEmail,
          amountCents: Math.round(Number(amount) * 100),
          anonymous,
          dedication: dedication.trim() || null,
          captchaToken,
        },
        checkoutSchema,
        crypto.randomUUID(),
      );
      window.location.assign(result.checkoutUrl);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Donation checkout could not be started.',
      );
      setBusy(false);
    }
  }

  return (
    <main className="public-fundraiser">
      {error ? <p role="alert">{error}</p> : null}
      {!campaign ? (
        <p role="status">{labels.loading}</p>
      ) : (
        <>
          <header className="public-fundraiser__hero">
            <p className="eyebrow">COMMUNITY FUNDRAISER</p>
            <h1>{campaign.name}</h1>
            <p>{descriptionText(campaign.descriptionHtml)}</p>
            <div className="public-fundraiser__progress">
              <progress
                aria-label={`${labels.progress} ${formatMoney(campaign.totalRaisedCents, locale)} of ${formatMoney(campaign.goalCents, locale)}`}
                max={campaign.goalCents}
                value={Math.min(campaign.totalRaisedCents, campaign.goalCents)}
              />
              <strong>
                {labels.progress}{' '}
                {formatMoney(campaign.totalRaisedCents, locale)} /{' '}
                {formatMoney(campaign.goalCents, locale)}
              </strong>
              <span>
                {campaign.donorCount} {labels.donors}
              </span>
            </div>
          </header>
          <div className="public-fundraiser__layout">
            <Card>
              <h2>{labels.donate}</h2>
              {searchParams.get('status') === 'success' ? (
                <p role="status">{labels.success}</p>
              ) : null}
              <form
                onSubmit={(event) => {
                  void donate(event);
                }}
              >
                <Field label={labels.name}>
                  <Input
                    autoComplete="name"
                    value={donorName}
                    onChange={(event) => {
                      setDonorName(event.target.value);
                    }}
                    maxLength={200}
                    required
                  />
                </Field>
                <Field label={labels.email}>
                  <Input
                    type="email"
                    autoComplete="email"
                    value={donorEmail}
                    onChange={(event) => {
                      setDonorEmail(event.target.value);
                    }}
                    maxLength={254}
                    required
                  />
                </Field>
                <Field label={labels.amount}>
                  <Input
                    type="number"
                    min="1"
                    max="25000"
                    step="0.01"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                    }}
                    required
                  />
                </Field>
                <label className="public-fundraiser__check">
                  <input
                    type="checkbox"
                    checked={anonymous}
                    onChange={(event) => {
                      setAnonymous(event.target.checked);
                    }}
                  />
                  {labels.anonymous}
                </label>
                <Field label={labels.dedication}>
                  <Textarea
                    value={dedication}
                    onChange={(event) => {
                      setDedication(event.target.value);
                    }}
                    maxLength={500}
                  />
                </Field>
                {captcha?.mode === 'turnstile' ? (
                  <TurnstileWidget
                    siteKey={captcha.siteKey}
                    onToken={handleCaptchaToken}
                    onError={handleCaptchaError}
                  />
                ) : null}
                {challengeError ? <p role="alert">{challengeError}</p> : null}
                <Button disabled={busy || !captchaToken}>
                  {busy ? 'Opening secure checkout…' : labels.submit}
                </Button>
              </form>
            </Card>
            {campaign.donorWall.length ? (
              <Card>
                <h2>Recent supporters</h2>
                <ol className="public-fundraiser__donors">
                  {campaign.donorWall.map((donor) => (
                    <li key={`${donor.paidAt}:${donor.donorName}`}>
                      <span>{donor.donorName}</span>
                      <strong>{formatMoney(donor.amountCents, locale)}</strong>
                    </li>
                  ))}
                </ol>
              </Card>
            ) : null}
          </div>
        </>
      )}
    </main>
  );
}
