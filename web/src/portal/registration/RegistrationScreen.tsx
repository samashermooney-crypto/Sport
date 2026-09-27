import { formatMoney } from '@shared/money';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';

import '../money/money.css';

const catalogSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      programId: z.uuid(),
      programSlug: z.string(),
      programName: z.string(),
      sport: z.string(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      divisionId: z.uuid().nullable(),
      priceCents: z.number().int().nonnegative(),
      status: z.enum(['opens_soon', 'open', 'full', 'closed']),
      waitlistEnabled: z.boolean(),
    }),
  ),
});
const participantsSchema = z.strictObject({
  people: z.array(
    z.strictObject({
      personId: z.uuid(),
      householdId: z.uuid(),
      name: z.string(),
      householdName: z.string(),
    }),
  ),
});
const startedSchema = z.strictObject({
  checkoutId: z.uuid(),
  expiresAt: z.iso.datetime(),
  status: z.enum(['open', 'awaiting_payment', 'completed']),
});

type CatalogItem = z.output<typeof catalogSchema>['items'][number];
type Participant = z.output<typeof participantsSchema>['people'][number];
type CartLine = {
  lineId: string;
  offeringId: string;
  personId: string;
  householdId: string;
  programId: string;
  programName: string;
  personName: string;
  priceCents: number;
};

export function RegistrationScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const [sport, setSport] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/registration/orgs/${encodeURIComponent(orgId)}`;
  const catalog = useQuery({
    queryKey: ['registration', orgId, 'catalog'],
    queryFn: () => apiGet(`${base}/catalog`, catalogSchema),
  });
  const participants = useQuery({
    queryKey: ['registration', orgId, 'participants'],
    queryFn: () => apiGet(`${base}/participants`, participantsSchema),
  });
  const sports = useMemo(
    () =>
      [...new Set(catalog.data?.items.map((item) => item.sport) ?? [])].sort(),
    [catalog.data],
  );
  const visible =
    catalog.data?.items.filter((item) => !sport || item.sport === sport) ?? [];
  const add = (item: CatalogItem): void => {
    const choice = selected[item.offeringId];
    const participant = participants.data?.people.find(
      (person) => `${person.personId}:${person.householdId}` === choice,
    );
    if (!participant) return;
    if (
      cart.some(
        (line) =>
          line.programId === item.programId &&
          line.personId === participant.personId,
      )
    ) {
      setError(`${participant.name} is already in this program's cart.`);
      return;
    }
    setError('');
    setCart((lines) => [
      ...lines,
      {
        lineId: crypto.randomUUID(),
        offeringId: item.offeringId,
        personId: participant.personId,
        householdId: participant.householdId,
        programId: item.programId,
        programName: item.programName,
        personName: participant.name,
        priceCents: item.priceCents,
      },
    ]);
  };
  const continueCheckout = async (): Promise<void> => {
    if (!cart.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiPost(
        base + '/checkouts',
        {
          offerings: cart.map(
            ({ lineId, offeringId, personId, householdId }) => ({
              lineId,
              offeringId,
              personId,
              householdId,
            }),
          ),
        },
        startedSchema,
        crypto.randomUUID(),
      );
      void navigate(
        `/portal/orgs/${orgId}/register/checkouts/${result.checkoutId}`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Registration is unavailable.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="REGISTRATION"
          title="Find a program"
          description="Choose programs for your family and reserve seats together."
        />
        <p>
          <Link to="/me/family">Manage family members</Link>
        </p>
        {(catalog.isLoading || participants.isLoading) && (
          <p role="status">Loading programs…</p>
        )}
        {(catalog.error || participants.error) && (
          <p role="alert" className="money-error">
            Programs are unavailable. Try again.
          </p>
        )}
        {catalog.data && participants.data && (
          <>
            <label htmlFor="registration-sport">Sport</label>
            <select
              id="registration-sport"
              value={sport}
              onChange={(event) => {
                setSport(event.target.value);
              }}
            >
              <option value="">All sports</option>
              {sports.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {visible.length === 0 && (
              <p>No programs are available for this filter.</p>
            )}
            {visible.map((item) => (
              <section className="money-panel" key={item.offeringId}>
                <h2>{item.programName}</h2>
                <p>
                  {item.sport} · {item.offeringName}
                </p>
                <p>{formatMoney(item.priceCents, i18n.language)}</p>
                <p>
                  {item.status === 'open'
                    ? 'Registration open'
                    : item.status === 'full'
                      ? 'Full'
                      : item.status === 'opens_soon'
                        ? 'Opens soon'
                        : 'Registration closed'}
                </p>
                {item.status === 'open' &&
                  participants.data.people.length > 0 && (
                    <>
                      <label htmlFor={`participant-${item.offeringId}`}>
                        Participant
                      </label>
                      <select
                        id={`participant-${item.offeringId}`}
                        value={selected[item.offeringId] ?? ''}
                        onChange={(event) => {
                          setSelected((current) => ({
                            ...current,
                            [item.offeringId]: event.target.value,
                          }));
                        }}
                      >
                        <option value="">Choose a family member</option>
                        {participants.data.people.map((person: Participant) => (
                          <option
                            key={`${person.personId}:${person.householdId}`}
                            value={`${person.personId}:${person.householdId}`}
                          >
                            {person.name} · {person.householdName}
                          </option>
                        ))}
                      </select>
                      <button
                        className="button"
                        type="button"
                        disabled={!selected[item.offeringId]}
                        onClick={() => {
                          add(item);
                        }}
                      >
                        Add to cart
                      </button>
                    </>
                  )}
              </section>
            ))}
          </>
        )}
        {cart.length > 0 && (
          <section className="money-panel" aria-labelledby="cart-title">
            <h2 id="cart-title">Your cart</h2>
            <ul>
              {cart.map((line) => (
                <li key={line.lineId}>
                  {line.personName} · {line.programName} ·{' '}
                  {formatMoney(line.priceCents, i18n.language)}{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setCart((items) =>
                        items.filter((item) => item.lineId !== line.lineId),
                      );
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void continueCheckout()}
            >
              {busy ? 'Reserving seats…' : 'Continue to review'}
            </button>
          </section>
        )}
        {error && (
          <p role="alert" className="money-error">
            {error}
          </p>
        )}
      </main>
    </PortalShell>
  );
}
