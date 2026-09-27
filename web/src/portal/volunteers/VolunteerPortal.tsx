import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, Field, Select } from '../../ui';

import './volunteers.css';

const householdsSchema = z.strictObject({
  households: z.array(
    z.strictObject({
      id: z.uuid(),
      personIds: z.array(z.uuid()),
      people: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
    }),
  ),
});
const shiftsSchema = z.strictObject({
  shifts: z.array(
    z.strictObject({
      id: z.uuid(),
      requirementId: z.uuid().nullable(),
      volunteerRoleId: z.uuid(),
      roleName: z.string(),
      eventId: z.uuid().nullable(),
      facilityId: z.uuid(),
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
      slots: z.number().int().positive(),
      filledSlots: z.number().int().nonnegative(),
      creditHours: z.number().nonnegative(),
      notes: z.string().nullable(),
      status: z.enum(['open', 'closed', 'completed', 'canceled']),
      version: z.number().int().positive(),
    }),
  ),
});
const ledgerSchema = z.strictObject({
  householdId: z.uuid(),
  items: z.array(
    z.strictObject({
      requirementId: z.uuid(),
      scopeId: z.uuid(),
      scopeName: z.string(),
      unit: z.enum(['hours', 'shifts']),
      subjectPersonId: z.uuid().nullable(),
      required: z.number().nonnegative(),
      completed: z.number().nonnegative(),
      boughtOut: z.number().nonnegative(),
      remaining: z.number().nonnegative(),
      deadline: z.iso.date(),
      buyoutPriceCents: z.number().int().nonnegative().nullable(),
      buyoutAvailable: z.boolean(),
    }),
  ),
});
const signupSchema = z.strictObject({
  id: z.uuid(),
  volunteerShiftId: z.uuid(),
  personId: z.uuid(),
  householdId: z.uuid(),
  status: z.enum([
    'signed_up',
    'confirmed',
    'checked_in',
    'completed',
    'no_show',
    'canceled',
  ]),
  hoursCredited: z.number().nonnegative(),
  version: z.number().int().positive(),
});
const buyoutSchema = z.strictObject({
  id: z.uuid(),
  invoiceId: z.uuid(),
  amountCents: z.number().int().nonnegative(),
  units: z.number().positive(),
});

type Household = z.output<typeof householdsSchema>['households'][number];
type Shift = z.output<typeof shiftsSchema>['shifts'][number];
type LedgerItem = z.output<typeof ledgerSchema>['items'][number];

export function VolunteerPortal({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/volunteers/orgs/${encodeURIComponent(orgId)}`;
  const [households, setHouseholds] = useState<Household[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [householdId, setHouseholdId] = useState('');
  const [personId, setPersonId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const now = useMemo(() => new Date(), []);
  const range = useMemo(() => {
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
    return new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }, [now]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [householdResult, shiftResult] = await Promise.all([
        apiGet(`${base}/me/households`, householdsSchema),
        apiGet(`${base}/shifts?${range.toString()}`, shiftsSchema),
      ]);
      setHouseholds(householdResult.households);
      setShifts(shiftResult.shifts);
      setHouseholdId((current) =>
        householdResult.households.some((item) => item.id === current)
          ? current
          : (householdResult.households[0]?.id ?? ''),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Volunteer information is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [base, range]);

  const refreshLedger = useCallback(async () => {
    if (!householdId) {
      setLedger([]);
      return;
    }
    try {
      const result = await apiGet(
        `${base}/households/${encodeURIComponent(householdId)}/ledger`,
        ledgerSchema,
      );
      setLedger(result.items);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Volunteer ledger is unavailable.',
      );
    }
  }, [base, householdId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshLedger();
  }, [refreshLedger]);
  const selectedHousehold = households.find((item) => item.id === householdId);
  useEffect(() => {
    if (selectedHousehold && !selectedHousehold.personIds.includes(personId))
      setPersonId(selectedHousehold.people[0]?.id ?? '');
  }, [selectedHousehold, personId]);

  async function signUp(shift: Shift): Promise<void> {
    if (!householdId || !personId) return;
    setBusyId(shift.id);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/shifts/${encodeURIComponent(shift.id)}/signups`,
        {
          householdId,
          personId,
        },
        signupSchema,
      );
      setNotice(
        `Signed up ${selectedHousehold?.people.find((person) => person.id === personId)?.name ?? 'participant'} for ${shift.roleName}.`,
      );
      await Promise.all([refresh(), refreshLedger()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Shift signup could not be completed.',
      );
    } finally {
      setBusyId('');
    }
  }

  async function buyOut(item: LedgerItem): Promise<void> {
    if (!householdId) return;
    setBusyId(item.requirementId);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/requirements/${encodeURIComponent(item.requirementId)}/buyouts`,
        {
          householdId,
          personId: item.subjectPersonId,
          units: item.remaining,
        },
        buyoutSchema,
        crypto.randomUUID(),
      );
      setNotice(
        `Buyout invoice created for $${(result.amountCents / 100).toFixed(2)}.`,
      );
      await refreshLedger();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Buyout could not be completed.',
      );
    } finally {
      setBusyId('');
    }
  }

  return (
    <main className="console-home volunteer-portal">
      <header className="volunteer-portal__header">
        <p className="eyebrow">FAMILY VOLUNTEER CENTER</p>
        <h1>Volunteer shifts</h1>
        <p>
          Choose a household participant, sign up for a shift and track
          requirement progress.
        </p>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? <p role="status">Loading volunteer shifts…</p> : null}
      <Card className="volunteer-portal__selection">
        <Field label="Household">
          <Select
            aria-label="Household"
            value={householdId}
            onChange={(event) => {
              setHouseholdId(event.target.value);
            }}
          >
            {households.map((household, index) => (
              <option key={household.id} value={household.id}>
                Household {index + 1}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Household member">
          <Select
            aria-label="Household member"
            value={personId}
            onChange={(event) => {
              setPersonId(event.target.value);
            }}
          >
            {selectedHousehold?.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      <section aria-labelledby="available-shifts-title">
        <h2 id="available-shifts-title">Available shifts</h2>
        <div className="volunteer-portal__grid">
          {shifts
            .filter(
              (shift) =>
                shift.status === 'open' &&
                shift.filledSlots < shift.slots &&
                new Date(shift.startsAt) > now,
            )
            .map((shift) => (
              <Card key={shift.id}>
                <h3>{shift.roleName}</h3>
                <p>{new Date(shift.startsAt).toLocaleString()}</p>
                <p>
                  {shift.creditHours} volunteer hours ·{' '}
                  {shift.slots - shift.filledSlots} spots
                </p>
                {shift.notes ? <p>{shift.notes}</p> : null}
                <Button
                  disabled={!householdId || !personId || Boolean(busyId)}
                  onClick={() => void signUp(shift)}
                >
                  {busyId === shift.id
                    ? 'Signing up…'
                    : `Sign up for ${shift.roleName}`}
                </Button>
              </Card>
            ))}
          {!loading &&
          shifts.filter(
            (shift) =>
              shift.status === 'open' &&
              shift.filledSlots < shift.slots &&
              new Date(shift.startsAt) > now,
          ).length === 0 ? (
            <p>No open shifts are available in the next six months.</p>
          ) : null}
        </div>
      </section>
      <section aria-labelledby="volunteer-progress-title">
        <h2 id="volunteer-progress-title">Household progress</h2>
        <div className="volunteer-portal__grid">
          {ledger.map((item) => (
            <Card
              key={`${item.requirementId}:${item.subjectPersonId ?? 'household'}`}
            >
              <h3>
                {item.scopeName}
                {item.subjectPersonId
                  ? ` · ${selectedHousehold?.people.find((person) => person.id === item.subjectPersonId)?.name ?? 'Participant'}`
                  : ''}
              </h3>
              <p>
                {item.completed + item.boughtOut} of {item.required} {item.unit}{' '}
                complete · {item.remaining} remaining
              </p>
              <p>Deadline {item.deadline}</p>
              {item.buyoutAvailable ? (
                <Button
                  secondary
                  disabled={Boolean(busyId)}
                  onClick={() => void buyOut(item)}
                >
                  {busyId === item.requirementId
                    ? 'Creating invoice…'
                    : `Buy out remaining ${item.unit}`}
                </Button>
              ) : null}
            </Card>
          ))}
          {ledger.length === 0 ? (
            <p>No volunteer requirements are assigned to this household.</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
