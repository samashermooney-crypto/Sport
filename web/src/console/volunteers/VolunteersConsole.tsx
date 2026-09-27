import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../../ui';

import './volunteers-console.css';

const uuid = z.uuid();
const rolesSchema = z.strictObject({
  roles: z.array(
    z.strictObject({
      id: uuid,
      name: z.string(),
      description: z.string().nullable().optional(),
      minimumAge: z.number().int().nonnegative(),
      archivedAt: z.iso.datetime().nullable(),
      version: z.number().int().positive(),
    }),
  ),
});
const requirementsSchema = z.strictObject({
  requirements: z.array(
    z.strictObject({
      id: uuid,
      seasonId: uuid.nullable(),
      programId: uuid.nullable(),
      scopeName: z.string(),
      unit: z.enum(['hours', 'shifts']),
      amountPerHousehold: z.number().positive().nullable(),
      amountPerAthlete: z.number().positive().nullable(),
      buyoutPriceCents: z.number().int().nonnegative().nullable(),
      deadline: z.iso.date(),
      autoInvoiceShortfall: z.boolean(),
      noticeDays: z.number().int().positive(),
      countsCoachRoles: z.boolean(),
      version: z.number().int().positive(),
    }),
  ),
});
const shiftsSchema = z.strictObject({
  shifts: z.array(
    z.strictObject({
      id: uuid,
      requirementId: uuid.nullable(),
      volunteerRoleId: uuid,
      roleName: z.string(),
      eventId: uuid.nullable(),
      facilityId: uuid,
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
const signupsSchema = z.strictObject({
  signups: z.array(
    z.strictObject({
      id: uuid,
      volunteerShiftId: uuid,
      personId: uuid,
      householdId: uuid,
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
      personName: z.string(),
    }),
  ),
});
const roleSchema = rolesSchema.shape.roles.element;
const requirementSchema = requirementsSchema.shape.requirements.element;
const shiftSchema = shiftsSchema.shape.shifts.element;
const signupSchema = signupsSchema.shape.signups.element;
type VolunteerRole = z.output<typeof roleSchema>;
type Requirement = z.output<typeof requirementSchema>;
type Shift = z.output<typeof shiftSchema>;
type Signup = z.output<typeof signupSchema>;

const localDate = (date: Date) => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
};

export function VolunteersConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/volunteers/orgs/${encodeURIComponent(orgId)}`;
  const [roles, setRoles] = useState<VolunteerRole[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [signups, setSignups] = useState<Record<string, Signup[]>>({});
  const [roleName, setRoleName] = useState('Event volunteer');
  const [minimumAge, setMinimumAge] = useState('18');
  const [scopeKind, setScopeKind] = useState<'season' | 'program'>('season');
  const [scopeId, setScopeId] = useState('');
  const [unit, setUnit] = useState<'shifts' | 'hours'>('shifts');
  const [requiredAmount, setRequiredAmount] = useState('2');
  const [appliesTo, setAppliesTo] = useState<'household' | 'athlete'>(
    'household',
  );
  const [deadline, setDeadline] = useState(
    localDate(new Date(Date.now() + 45 * 86_400_000)),
  );
  const [buyout, setBuyout] = useState('');
  const [autoInvoice, setAutoInvoice] = useState(false);
  const [noticeDays, setNoticeDays] = useState('14');
  const [roleId, setRoleId] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [startDate, setStartDate] = useState(
    localDate(new Date(Date.now() + 7 * 86_400_000)),
  );
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('11:00');
  const [slots, setSlots] = useState('4');
  const [creditHours, setCreditHours] = useState('2');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 86_400_000).toISOString();
    const to = new Date(now.getTime() + 180 * 86_400_000).toISOString();
    try {
      const [roleResult, requirementResult, shiftResult] = await Promise.all([
        apiGet(`${base}/roles`, rolesSchema),
        apiGet(`${base}/requirements`, requirementsSchema),
        apiGet(
          `${base}/shifts?${new URLSearchParams({ from, to }).toString()}`,
          shiftsSchema,
        ),
      ]);
      setRoles(roleResult.roles);
      setRequirements(requirementResult.requirements);
      setShifts(shiftResult.shifts);
      setRoleId((current) =>
        roleResult.roles.some((item) => item.id === current)
          ? current
          : (roleResult.roles[0]?.id ?? ''),
      );
      setRequirementId((current) =>
        requirementResult.requirements.some((item) => item.id === current)
          ? current
          : '',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Volunteer management data is unavailable.',
      );
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeRoles = useMemo(
    () => roles.filter((role) => !role.archivedAt),
    [roles],
  );

  async function createRole(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/roles`,
        { name: roleName, minimumAge: Number(minimumAge) },
        roleSchema,
      );
      setNotice('Volunteer role created.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Volunteer role could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createRequirement(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!scopeId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/requirements`,
        {
          seasonId: scopeKind === 'season' ? scopeId : null,
          programId: scopeKind === 'program' ? scopeId : null,
          unit,
          amountPerHousehold:
            appliesTo === 'household' ? Number(requiredAmount) : null,
          amountPerAthlete:
            appliesTo === 'athlete' ? Number(requiredAmount) : null,
          buyoutPriceCents: buyout ? Math.round(Number(buyout) * 100) : null,
          deadline,
          autoInvoiceShortfall: autoInvoice,
          noticeDays: Number(noticeDays),
          countsCoachRoles: false,
        },
        requirementSchema,
      );
      setNotice('Volunteer requirement created.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Volunteer requirement could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createShift(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!roleId || !facilityId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/shifts`,
        {
          requirementId: requirementId || null,
          volunteerRoleId: roleId,
          facilityId,
          startsAt: new Date(`${startDate}T${startTime}:00`).toISOString(),
          endsAt: new Date(`${startDate}T${endTime}:00`).toISOString(),
          slots: Number(slots),
          creditHours: Number(creditHours),
          notes: notes.trim() || null,
        },
        shiftSchema,
      );
      setNotice('Volunteer shift created.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Volunteer shift could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadSignups(shift: Shift): Promise<void> {
    setError('');
    try {
      const result = await apiGet(
        `${base}/shifts/${encodeURIComponent(shift.id)}/signups`,
        signupsSchema,
      );
      setSignups((current) => ({ ...current, [shift.id]: result.signups }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Shift signups are unavailable.',
      );
    }
  }

  async function updateSignup(
    shift: Shift,
    signup: Signup,
    status: Signup['status'],
  ): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `${base}/signups/${encodeURIComponent(signup.id)}`,
        {
          status,
          expectedVersion: signup.version,
          ...(status === 'completed'
            ? { hoursCredited: shift.creditHours }
            : {}),
        },
        signupSchema,
      );
      setNotice(`${signup.personName} marked ${status.replaceAll('_', ' ')}.`);
      await loadSignups(shift);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Signup status could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-home volunteer-console">
      <PageHeader
        kicker="VOLUNTEER OPERATIONS"
        title="Volunteers"
        description="Manage eligible roles, household requirements, shifts, check-ins and credited hours."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="volunteer-console__forms">
        <Card>
          <h2>Volunteer roles</h2>
          <form
            onSubmit={(event) => {
              void createRole(event);
            }}
          >
            <Field label="Role name">
              <Input
                value={roleName}
                onChange={(event) => {
                  setRoleName(event.target.value);
                }}
                maxLength={120}
                required
              />
            </Field>
            <Field label="Minimum age">
              <Input
                type="number"
                min="0"
                max="120"
                value={minimumAge}
                onChange={(event) => {
                  setMinimumAge(event.target.value);
                }}
                required
              />
            </Field>
            <Button disabled={busy}>Create role</Button>
          </form>
        </Card>
        <Card>
          <h2>Household requirement</h2>
          <form
            onSubmit={(event) => {
              void createRequirement(event);
            }}
          >
            <Field label="Scope type">
              <Select
                value={scopeKind}
                onChange={(event) => {
                  setScopeKind(event.target.value as typeof scopeKind);
                }}
              >
                <option value="season">Season</option>
                <option value="program">Program</option>
              </Select>
            </Field>
            <Field
              label={`${scopeKind === 'season' ? 'Season' : 'Program'} ID`}
              hint="Select the record ID from the season or program page."
            >
              <Input
                value={scopeId}
                onChange={(event) => {
                  setScopeId(event.target.value);
                }}
                pattern="[0-9a-fA-F-]{36}"
                required
              />
            </Field>
            <Field label="Requirement applies to">
              <Select
                value={appliesTo}
                onChange={(event) => {
                  setAppliesTo(event.target.value as typeof appliesTo);
                }}
              >
                <option value="household">Household</option>
                <option value="athlete">Each athlete</option>
              </Select>
            </Field>
            <Field label="Unit">
              <Select
                value={unit}
                onChange={(event) => {
                  setUnit(event.target.value as typeof unit);
                }}
              >
                <option value="shifts">Shifts</option>
                <option value="hours">Hours</option>
              </Select>
            </Field>
            <Field label={`Required ${unit}`}>
              <Input
                type="number"
                min="0.25"
                step="0.25"
                value={requiredAmount}
                onChange={(event) => {
                  setRequiredAmount(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Buyout per unit in dollars">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={buyout}
                onChange={(event) => {
                  setBuyout(event.target.value);
                }}
              />
            </Field>
            <Field label="Deadline">
              <Input
                type="date"
                value={deadline}
                onChange={(event) => {
                  setDeadline(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Shortfall notice days">
              <Input
                type="number"
                min="1"
                max="90"
                value={noticeDays}
                onChange={(event) => {
                  setNoticeDays(event.target.value);
                }}
                required
              />
            </Field>
            <label className="volunteer-console__check">
              <input
                type="checkbox"
                checked={autoInvoice}
                onChange={(event) => {
                  setAutoInvoice(event.target.checked);
                }}
              />{' '}
              Automatically invoice remaining buyout after notice
            </label>
            <Button disabled={busy || !scopeId}>Create requirement</Button>
          </form>
        </Card>
        <Card>
          <h2>Schedule a shift</h2>
          <form
            onSubmit={(event) => {
              void createShift(event);
            }}
          >
            <Field label="Volunteer role">
              <Select
                value={roleId}
                onChange={(event) => {
                  setRoleId(event.target.value);
                }}
              >
                <option value="">Choose role</option>
                {activeRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} · age {role.minimumAge}+
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Requirement">
              <Select
                value={requirementId}
                onChange={(event) => {
                  setRequirementId(event.target.value);
                }}
              >
                <option value="">No requirement link</option>
                {requirements.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.scopeName} ·{' '}
                    {item.amountPerHousehold ?? item.amountPerAthlete}{' '}
                    {item.unit}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Facility ID"
              hint="Enter the facility ID from the facility record."
            >
              <Input
                value={facilityId}
                onChange={(event) => {
                  setFacilityId(event.target.value);
                }}
                pattern="[0-9a-fA-F-]{36}"
                required
              />
            </Field>
            <Field label="Shift date">
              <Input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Starts at">
              <Input
                type="time"
                value={startTime}
                onChange={(event) => {
                  setStartTime(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Ends at">
              <Input
                type="time"
                value={endTime}
                onChange={(event) => {
                  setEndTime(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Volunteer spots">
              <Input
                type="number"
                min="1"
                max="1000"
                value={slots}
                onChange={(event) => {
                  setSlots(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Credited hours">
              <Input
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={creditHours}
                onChange={(event) => {
                  setCreditHours(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Shift details">
              <Textarea
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value);
                }}
                maxLength={2000}
              />
            </Field>
            <Button disabled={busy || !roleId || !facilityId}>
              Create shift
            </Button>
          </form>
        </Card>
      </div>
      <section
        className="volunteer-console__list"
        aria-labelledby="shift-list-title"
      >
        <h2 id="shift-list-title">Upcoming shifts</h2>
        {shifts.map((shift) => (
          <Card key={shift.id}>
            <div className="volunteer-console__shift">
              <div>
                <h3>{shift.roleName}</h3>
                <p>
                  {new Date(shift.startsAt).toLocaleString()} ·{' '}
                  {shift.filledSlots}/{shift.slots} spots · {shift.creditHours}{' '}
                  hours
                </p>
                <p>Facility {shift.facilityId}</p>
              </div>
              <Button
                secondary
                onClick={() => {
                  void loadSignups(shift);
                }}
              >
                View signups
              </Button>
            </div>
            {signups[shift.id] ? (
              <ul className="volunteer-console__signups">
                {signups[shift.id]?.map((signup) => (
                  <li key={signup.id}>
                    <span>
                      {signup.personName} · {signup.status.replaceAll('_', ' ')}
                    </span>
                    <span>{signup.hoursCredited} hours credited</span>
                    <div>
                      {(['checked_in', 'completed', 'no_show'] as const).map(
                        (status) => (
                          <Button
                            key={status}
                            secondary
                            disabled={busy || signup.status === status}
                            onClick={() => {
                              void updateSignup(shift, signup, status);
                            }}
                          >
                            {status === 'no_show'
                              ? 'No show'
                              : status === 'checked_in'
                                ? 'Check in'
                                : 'Complete & credit'}
                          </Button>
                        ),
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        ))}
        {shifts.length === 0 ? <p>No shifts in the next six months.</p> : null}
      </section>
    </main>
  );
}
