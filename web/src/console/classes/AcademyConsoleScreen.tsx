import { zodResolver } from '@hookform/resolvers/zod';
import { formatMoney } from '@shared/money';
import {
  academyDashboardSchema,
  classOfferingBodySchema,
  classOfferingListSchema,
  classOfferingSchema,
  classOfferingUpdateSchema,
  classScheduleBodySchema,
  classScheduleListSchema,
  classSessionListSchema,
  promotionListSchema,
  promotionSchema,
  sessionRosterSchema,
  sessionSkillMarksSchema,
  skillBodySchema,
  skillLevelBodySchema,
  skillLevelDetailSchema,
  skillLevelListSchema,
  tuitionSubscriptionListSchema,
} from '@shared/schemas/classes';
import { peopleListSchema } from '@shared/schemas/people';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  StatTile,
  Tabs,
  Textarea,
} from '../../ui';
import type { Column } from '../../ui';

import './classes.css';

const offeringResponseSchema = z.strictObject({
  offering: classOfferingSchema,
});
const scheduleResponseSchema = z.strictObject({
  schedule: z.object({
    id: z.uuid(),
    sessionCount: z.number().int().nonnegative(),
  }),
});
const attendanceResponseSchema = z.strictObject({
  marked: z.number().int().nonnegative(),
  creditsIssued: z.number().int().nonnegative(),
});
const promotionResponseSchema = z.strictObject({ promotion: promotionSchema });
const promotionDecisionResponseSchema = z.strictObject({
  promotion: promotionSchema,
});
const skillResponseSchema = z.strictObject({
  skill: z.object({ id: z.uuid() }),
});
const levelResponseSchema = z.strictObject({
  level: z.object({ id: z.uuid() }),
});
const syncResponseSchema = z.strictObject({
  levelsCreated: z.number().int().nonnegative(),
  skillsCreated: z.number().int().nonnegative(),
});
const pickupPeopleSchema = z.strictObject({
  items: z.array(z.strictObject({ personId: z.uuid(), name: z.string() })),
});
const checkedInSchema = z.strictObject({ checkedInAt: z.iso.datetime() });
const checkedOutSchema = z.strictObject({
  checkedOutAt: z.iso.datetime(),
  pickedUpBy: z.string(),
});

type Offering = z.infer<typeof classOfferingSchema>;
type FormOffering = z.input<typeof classOfferingBodySchema>;
type OfferingOutput = z.output<typeof classOfferingBodySchema>;
type Session = z.output<typeof classSessionListSchema>['items'][number];
type Level = z.output<typeof skillLevelListSchema>['items'][number];
type ClassSchedule = z.output<typeof classScheduleListSchema>['items'][number];

const defaultOffering: FormOffering = {
  programId: '',
  skillLevelId: null,
  name: '',
  description: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  capacity: 12,
  instructorRatio: 8,
  billing: 'monthly',
  priceCents: 0,
  punchCardUses: null,
  tuitionTiers: [],
  annualFeeCents: 0,
  trialAllowed: false,
  trialPriceCents: 0,
  makeupPolicy: {
    creditsPerTerm: 0,
    expiryDays: 90,
    eligibleLevelIds: null,
    eligibleOfferingIds: null,
  },
  siblingDiscountBps: [],
  status: 'active',
};

function dateOnly(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return dateOnly(value);
}

function monthName(month: string): string {
  const value = new Date(`${month}-01T12:00:00`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
  }).format(value);
}

function ageRange(offering: Offering): string {
  if (offering.ageMinMonths === null && offering.ageMaxMonths === null)
    return 'All ages';
  const min =
    offering.ageMinMonths === null
      ? 'Any age'
      : `${String(offering.ageMinMonths)} mo`;
  const max =
    offering.ageMaxMonths === null
      ? 'Any age'
      : `${String(offering.ageMaxMonths)} mo`;
  return `${min}–${max}`;
}

function formatWhen(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function offeringDefaults(offering: Offering): FormOffering {
  return {
    programId: offering.programId,
    skillLevelId: offering.skillLevelId,
    name: offering.name,
    description: offering.description,
    ageMinMonths: offering.ageMinMonths,
    ageMaxMonths: offering.ageMaxMonths,
    capacity: offering.capacity,
    instructorRatio: offering.instructorRatio,
    billing: offering.billing,
    priceCents: offering.priceCents,
    punchCardUses: offering.punchCardUses,
    tuitionTiers: offering.tuitionTiers,
    annualFeeCents: offering.annualFeeCents,
    trialAllowed: offering.trialAllowed,
    trialPriceCents: offering.trialPriceCents,
    makeupPolicy: offering.makeupPolicy,
    siblingDiscountBps: offering.siblingDiscountBps,
    status: offering.status === 'archived' ? 'draft' : offering.status,
  };
}

function OfferingForm({
  current,
  levels,
  busy,
  onSave,
  onCancel,
}: {
  current: Offering | null;
  levels: Level[];
  busy: boolean;
  onSave: (body: OfferingOutput) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const form = useForm<FormOffering, unknown, OfferingOutput>({
    resolver: zodResolver(classOfferingBodySchema),
    defaultValues: current ? offeringDefaults(current) : defaultOffering,
  });
  useEffect(() => {
    form.reset(current ? offeringDefaults(current) : defaultOffering);
  }, [current, form]);

  return (
    <form
      className="academy-form"
      onSubmit={(event) => {
        void form.handleSubmit(onSave)(event);
      }}
      noValidate
    >
      <h3>{current ? 'Edit class offering' : 'Create a class offering'}</h3>
      <Field
        label="Class program ID"
        required
        hint="Enter the ID of an existing class-mode program."
        error={form.formState.errors.programId?.message}
      >
        <Input {...form.register('programId')} readOnly={Boolean(current)} />
      </Field>
      <Field
        label="Class name"
        required
        error={form.formState.errors.name?.message}
      >
        <Input {...form.register('name')} />
      </Field>
      <Field label="Skill level">
        <Select {...form.register('skillLevelId')}>
          <option value="">No level assigned</option>
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Description"
        error={form.formState.errors.description?.message}
      >
        <Textarea {...form.register('description')} />
      </Field>
      <div className="academy-form-grid">
        <Field
          label="Billing"
          required
          error={form.formState.errors.billing?.message}
        >
          <Select {...form.register('billing')}>
            <option value="term">Term tuition</option>
            <option value="monthly">Monthly tuition</option>
            <option value="drop_in">Drop-in</option>
            <option value="punch_card">Punch card</option>
          </Select>
        </Field>
        <Field
          label="Price (cents)"
          required
          error={form.formState.errors.priceCents?.message}
        >
          <Input
            type="number"
            min="0"
            step="1"
            {...form.register('priceCents', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Capacity"
          required
          error={form.formState.errors.capacity?.message}
        >
          <Input
            type="number"
            min="1"
            step="1"
            {...form.register('capacity', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Instructor ratio"
          required
          error={form.formState.errors.instructorRatio?.message}
        >
          <Input
            type="number"
            min="0.25"
            step="0.25"
            {...form.register('instructorRatio', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Minimum age (months)"
          error={form.formState.errors.ageMinMonths?.message}
        >
          <Input
            type="number"
            min="0"
            step="1"
            value={form.watch('ageMinMonths') ?? ''}
            onChange={(event) => {
              form.setValue(
                'ageMinMonths',
                event.target.value ? Number(event.target.value) : null,
                { shouldValidate: true },
              );
            }}
          />
        </Field>
        <Field
          label="Maximum age (months)"
          error={form.formState.errors.ageMaxMonths?.message}
        >
          <Input
            type="number"
            min="0"
            step="1"
            value={form.watch('ageMaxMonths') ?? ''}
            onChange={(event) => {
              form.setValue(
                'ageMaxMonths',
                event.target.value ? Number(event.target.value) : null,
                { shouldValidate: true },
              );
            }}
          />
        </Field>
        <Field
          label="Annual registration fee (cents)"
          error={form.formState.errors.annualFeeCents?.message}
        >
          <Input
            type="number"
            min="0"
            step="1"
            {...form.register('annualFeeCents', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Make-up credits per term"
          error={form.formState.errors.makeupPolicy?.creditsPerTerm?.message}
        >
          <Input
            type="number"
            min="0"
            step="1"
            {...form.register('makeupPolicy.creditsPerTerm', {
              valueAsNumber: true,
            })}
          />
        </Field>
        {form.watch('billing') === 'punch_card' && (
          <Field
            label="Punch card uses"
            required
            error={form.formState.errors.punchCardUses?.message}
          >
            <Input
              type="number"
              min="1"
              step="1"
              {...form.register('punchCardUses', { valueAsNumber: true })}
            />
          </Field>
        )}
      </div>
      {form.watch('billing') === 'monthly' && (
        <section className="academy-inset">
          <h4>Family tuition tiers</h4>
          <p>
            Set one total monthly price for the household by classes per week.
            When tiers are set, they replace per-student tuition and sibling
            discounts.
          </p>
          {(form.watch('tuitionTiers') ?? []).map((tier, index) => (
            <div className="academy-tier-row" key={`tier-${String(index)}`}>
              <Field
                label={`Tier ${String(index + 1)}: maximum classes per week`}
              >
                <Input
                  aria-label={`Tier ${String(index + 1)}: maximum classes per week`}
                  type="number"
                  min="1"
                  step="1"
                  value={tier.maxClassesPerWeek ?? ''}
                  onChange={(event) => {
                    const next = [...(form.getValues('tuitionTiers') ?? [])];
                    next[index] = {
                      ...tier,
                      maxClassesPerWeek: event.target.value
                        ? Number(event.target.value)
                        : null,
                    };
                    form.setValue('tuitionTiers', next, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                  }}
                />
              </Field>
              <Field
                label={`Tier ${String(index + 1)}: monthly amount (cents)`}
              >
                <Input
                  aria-label={`Tier ${String(index + 1)}: monthly amount (cents)`}
                  type="number"
                  min="0"
                  step="1"
                  value={tier.amountCents}
                  onChange={(event) => {
                    const next = [...(form.getValues('tuitionTiers') ?? [])];
                    next[index] = {
                      ...tier,
                      amountCents: Number(event.target.value),
                    };
                    form.setValue('tuitionTiers', next, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                  }}
                />
              </Field>
              <Button
                type="button"
                secondary
                onClick={() => {
                  form.setValue(
                    'tuitionTiers',
                    (form.getValues('tuitionTiers') ?? []).filter(
                      (_, row) => row !== index,
                    ),
                    { shouldDirty: true, shouldValidate: true },
                  );
                }}
              >
                Remove tier
              </Button>
            </div>
          ))}
          <Button
            type="button"
            secondary
            disabled={(form.watch('tuitionTiers') ?? []).length >= 12}
            onClick={() => {
              form.setValue(
                'tuitionTiers',
                [
                  ...(form.getValues('tuitionTiers') ?? []),
                  { maxClassesPerWeek: null, amountCents: 0 },
                ],
                { shouldDirty: true, shouldValidate: true },
              );
            }}
          >
            Add tuition tier
          </Button>
        </section>
      )}
      {form.watch('billing') === 'monthly' &&
        !(form.watch('tuitionTiers') ?? []).length && (
          <section className="academy-inset">
            <h4>Sibling discounts</h4>
            <p>
              Discounts apply to the second and later enrollment in this
              offering, from the second cheapest enrollment onward.
            </p>
            {(form.watch('siblingDiscountBps') ?? []).map((discount, index) => (
              <div
                className="academy-tier-row"
                key={`sibling-${String(index)}`}
              >
                <Field
                  label={`Discount for sibling ${String(index + 2)} (basis points)`}
                >
                  <Input
                    aria-label={`Discount for sibling ${String(index + 2)} (basis points)`}
                    type="number"
                    min="0"
                    max="10000"
                    step="1"
                    value={discount}
                    onChange={(event) => {
                      const next = [
                        ...(form.getValues('siblingDiscountBps') ?? []),
                      ];
                      next[index] = Number(event.target.value);
                      form.setValue('siblingDiscountBps', next, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    form.setValue(
                      'siblingDiscountBps',
                      (form.getValues('siblingDiscountBps') ?? []).filter(
                        (_, row) => row !== index,
                      ),
                      { shouldDirty: true, shouldValidate: true },
                    );
                  }}
                >
                  Remove discount
                </Button>
              </div>
            ))}
            <Button
              type="button"
              secondary
              disabled={(form.watch('siblingDiscountBps') ?? []).length >= 10}
              onClick={() => {
                form.setValue(
                  'siblingDiscountBps',
                  [...(form.getValues('siblingDiscountBps') ?? []), 0],
                  { shouldDirty: true, shouldValidate: true },
                );
              }}
            >
              Add sibling discount
            </Button>
          </section>
        )}
      <label className="academy-check">
        <input type="checkbox" {...form.register('trialAllowed')} />
        <span>Allow a trial class</span>
      </label>
      {form.watch('trialAllowed') && (
        <Field
          label="Trial price (cents)"
          error={form.formState.errors.trialPriceCents?.message}
        >
          <Input
            type="number"
            min="0"
            step="1"
            {...form.register('trialPriceCents', { valueAsNumber: true })}
          />
        </Field>
      )}
      {form.formState.errors.root?.message && (
        <p className="field-error" role="alert">
          {form.formState.errors.root.message}
        </p>
      )}
      <div className="ui-page-actions">
        <Button disabled={busy}>
          {busy ? 'Saving…' : current ? 'Save changes' : 'Create class'}
        </Button>
        {current && (
          <Button type="button" secondary onClick={onCancel}>
            Cancel editing
          </Button>
        )}
      </div>
    </form>
  );
}

function ScheduleForm({
  offering,
  busy,
  onSave,
}: {
  offering: Offering;
  busy: boolean;
  onSave: (body: z.output<typeof classScheduleBodySchema>) => void;
}): React.JSX.Element {
  const today = dateOnly(new Date());
  const initialEnd = addDays(today, 89);
  const [days, setDays] = useState<string[]>(['MO', 'WE']);
  const form = useForm<
    z.input<typeof classScheduleBodySchema>,
    unknown,
    z.output<typeof classScheduleBodySchema>
  >({
    resolver: zodResolver(classScheduleBodySchema),
    defaultValues: {
      recurrence: {
        kind: 'weekly',
        interval: 1,
        byDay: ['MO', 'WE'],
        startsOn: today,
        endsOn: initialEnd,
        exceptions: [],
        additions: [],
      },
      startTime: '16:00',
      durationMinutes: 60,
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
      spaceId: null,
      locationText: '',
      termStart: today,
      termEnd: initialEnd,
    },
  });
  const start = form.watch('termStart');
  const end = form.watch('termEnd');
  return (
    <form
      className="academy-form"
      onSubmit={(event) => {
        void form.handleSubmit((value) => {
          onSave({
            ...value,
            locationText: value.locationText || null,
            recurrence: {
              kind: 'weekly',
              interval: 1,
              byDay: days as ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[],
              startsOn: value.termStart,
              endsOn: value.termEnd,
              exceptions: [],
              additions: [],
            },
          });
        })(event);
      }}
      noValidate
    >
      <h3>Schedule {offering.name}</h3>
      <p>
        Each scheduled occurrence becomes a class session. Facility closures and
        holidays are skipped automatically.
      </p>
      <fieldset className="academy-days">
        <legend>Days each week</legend>
        {(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const).map((day) => (
          <label className="academy-check" key={day}>
            <input
              type="checkbox"
              checked={days.includes(day)}
              onChange={(event) => {
                setDays((current) =>
                  event.target.checked
                    ? [...current, day]
                    : current.filter((value) => value !== day),
                );
              }}
            />
            <span>{day}</span>
          </label>
        ))}
      </fieldset>
      <div className="academy-form-grid">
        <Field
          label="Term starts"
          required
          error={form.formState.errors.termStart?.message}
        >
          <Input type="date" {...form.register('termStart')} />
        </Field>
        <Field
          label="Term ends"
          required
          error={form.formState.errors.termEnd?.message}
        >
          <Input type="date" {...form.register('termEnd')} />
        </Field>
        <Field
          label="Start time"
          required
          error={form.formState.errors.startTime?.message}
        >
          <Input type="time" {...form.register('startTime')} />
        </Field>
        <Field
          label="Duration (minutes)"
          required
          error={form.formState.errors.durationMinutes?.message}
        >
          <Input
            type="number"
            min="5"
            max="1440"
            step="5"
            {...form.register('durationMinutes', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Time zone"
          required
          error={form.formState.errors.timezone?.message}
        >
          <Input {...form.register('timezone')} />
        </Field>
        <Field
          label="Location"
          error={form.formState.errors.locationText?.message}
        >
          <Input {...form.register('locationText')} />
        </Field>
      </div>
      {(!start || !end || start > end || days.length === 0) && (
        <Banner tone="warning">
          Choose at least one day and a valid term date range.
        </Banner>
      )}
      <Button disabled={busy || !days.length || !start || !end || start > end}>
        {busy ? 'Generating sessions…' : 'Create schedule and sessions'}
      </Button>
    </form>
  );
}

export function AcademyConsoleScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/classes/orgs/${encodeURIComponent(orgId)}`;
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('Overview');
  const [editing, setEditing] = useState<Offering | null>(null);
  const [scheduleOffering, setScheduleOffering] = useState<Offering | null>(
    null,
  );
  const [selectedSession, setSelectedSession] = useState('');
  const [selectedSchedule, setSelectedSchedule] = useState('');
  const [selectedInstructor, setSelectedInstructor] = useState('');
  const [selectedSubstitute, setSelectedSubstitute] = useState('');
  const [attendance, setAttendance] = useState<Record<string, string>>({});
  const [selectedAthlete, setSelectedAthlete] = useState('');
  const [selectedPickup, setSelectedPickup] = useState('');
  const [sessionSkillId, setSessionSkillId] = useState('');
  const [sessionSkillStatus, setSessionSkillStatus] = useState<
    'not_started' | 'in_progress' | 'achieved'
  >('in_progress');
  const [personId, setPersonId] = useState('');
  const [levelId, setLevelId] = useState('');
  const [skillId, setSkillId] = useState('');
  const [promotionOfferingId, setPromotionOfferingId] = useState('');
  const [promotionNote, setPromotionNote] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const createKey = useRef<string | null>(null);
  const today = dateOnly(new Date());
  const endDate = addDays(today, 45);

  const dashboard = useQuery({
    queryKey: ['classes', orgId, 'dashboard'],
    queryFn: () => apiGet(`${base}/dashboard`, academyDashboardSchema),
  });
  const offerings = useQuery({
    queryKey: ['classes', orgId, 'offerings'],
    queryFn: () =>
      apiGet(`${base}/offerings?limit=200`, classOfferingListSchema),
  });
  const levels = useQuery({
    queryKey: ['classes', orgId, 'levels'],
    queryFn: () => apiGet(`${base}/levels`, skillLevelListSchema),
  });
  const subscriptions = useQuery({
    queryKey: ['classes', orgId, 'subscriptions'],
    queryFn: () =>
      apiGet(`${base}/subscriptions?limit=200`, tuitionSubscriptionListSchema),
  });
  const promotions = useQuery({
    queryKey: ['classes', orgId, 'promotions'],
    queryFn: () => apiGet(`${base}/promotions?limit=200`, promotionListSchema),
  });
  const people = useQuery({
    queryKey: ['people', orgId, 'instructors'],
    queryFn: () =>
      apiGet(
        `/people/orgs/${encodeURIComponent(orgId)}?status=active&limit=200`,
        peopleListSchema,
      ),
  });
  const sessions = useQuery({
    queryKey: ['classes', orgId, 'sessions', today, endDate],
    queryFn: () =>
      apiGet(
        `${base}/sessions?from=${today}&to=${endDate}&limit=500`,
        classSessionListSchema,
      ),
  });
  const roster = useQuery({
    queryKey: ['classes', orgId, 'session', selectedSession, 'roster'],
    queryFn: () =>
      apiGet(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/roster`,
        sessionRosterSchema,
      ),
    enabled: Boolean(selectedSession),
  });
  const pickups = useQuery({
    queryKey: [
      'classes',
      orgId,
      'session',
      selectedSession,
      'pickups',
      selectedAthlete,
    ],
    queryFn: () =>
      apiGet(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/people/${encodeURIComponent(selectedAthlete)}/pickups`,
        pickupPeopleSchema,
      ),
    enabled: Boolean(selectedSession && selectedAthlete),
  });
  const selectedLevel = useQuery({
    queryKey: ['classes', orgId, 'level', levelId],
    queryFn: () =>
      apiGet(
        `${base}/levels/${encodeURIComponent(levelId)}`,
        z.strictObject({ level: skillLevelDetailSchema }),
      ),
    enabled: Boolean(levelId),
  });
  const scheduleQueries = useQueries({
    queries: (offerings.data?.items ?? []).map((offering) => ({
      queryKey: ['classes', orgId, 'offering', offering.id, 'schedules'],
      queryFn: () =>
        apiGet(
          `${base}/offerings/${encodeURIComponent(offering.id)}/schedules`,
          classScheduleListSchema,
        ),
    })),
  });
  const scheduleRows: ClassSchedule[] = scheduleQueries.flatMap(
    (query) => query.data?.items ?? [],
  );
  const scheduleInstructors = useQuery({
    queryKey: ['classes', orgId, 'schedule', selectedSchedule, 'instructors'],
    queryFn: () =>
      apiGet(
        `${base}/schedules/${encodeURIComponent(selectedSchedule)}/instructors`,
        z.strictObject({
          items: z.array(
            z.object({
              personId: z.uuid(),
              name: z.string(),
              status: z.string(),
              eligible: z.boolean(),
              missing: z.array(
                z.looseObject({ code: z.string(), message: z.string() }),
              ),
            }),
          ),
        }),
      ),
    enabled: Boolean(selectedSchedule),
  });

  useEffect(() => {
    if (roster.data) {
      setAttendance(
        Object.fromEntries(
          roster.data.attendees.map((item) => [item.personId, item.status]),
        ),
      );
    }
  }, [roster.data]);
  useEffect(() => {
    setSelectedPickup('');
  }, [pickups.data]);

  const refreshClasses = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['classes', orgId] }),
      queryClient.invalidateQueries({ queryKey: ['people', orgId] }),
    ]);
  };
  const saveOffering = useMutation({
    mutationFn: async (body: OfferingOutput) => {
      if (editing) {
        const values = Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== 'programId'),
        );
        return apiPatch(
          `${base}/offerings/${encodeURIComponent(editing.id)}`,
          classOfferingUpdateSchema.parse({
            ...values,
            expectedVersion: editing.version,
          }),
          offeringResponseSchema,
        );
      }
      createKey.current ??= crypto.randomUUID();
      return apiPost(
        `${base}/offerings`,
        body,
        offeringResponseSchema,
        createKey.current,
      );
    },
    onSuccess: async ({ offering }) => {
      createKey.current = null;
      setEditing(null);
      setError('');
      setNotice(`${offering.name} saved.`);
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The class could not be saved.',
      );
    },
  });
  const archiveOffering = useMutation({
    mutationFn: (offering: Offering) =>
      apiPost(
        `${base}/offerings/${encodeURIComponent(offering.id)}/archive`,
        { expectedVersion: offering.version },
        z.null(),
      ),
    onSuccess: async () => {
      setNotice('Class offering archived.');
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The offering could not be archived.',
      );
    },
  });
  const createSchedule = useMutation({
    mutationFn: (input: {
      offering: Offering;
      body: z.output<typeof classScheduleBodySchema>;
    }) =>
      apiPost(
        `${base}/offerings/${encodeURIComponent(input.offering.id)}/schedules`,
        input.body,
        scheduleResponseSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async ({ schedule }) => {
      setNotice(`${String(schedule.sessionCount)} class sessions generated.`);
      setScheduleOffering(null);
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The schedule could not be created.',
      );
    },
  });
  const markAttendance = useMutation({
    mutationFn: () =>
      apiPost(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/attendance`,
        {
          marks: Object.entries(attendance).map(([athlete, status]) => ({
            personId: athlete,
            status,
          })),
        },
        attendanceResponseSchema,
      ),
    onSuccess: async ({ creditsIssued }) => {
      setNotice(
        `Attendance saved. ${String(creditsIssued)} make-up credits issued.`,
      );
      await queryClient.invalidateQueries({
        queryKey: ['classes', orgId, 'session', selectedSession, 'roster'],
      });
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Attendance could not be saved.',
      );
    },
  });
  const markSessionSkill = useMutation({
    mutationFn: (athleteId: string) =>
      apiPost(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/skills`,
        sessionSkillMarksSchema.parse({
          marks: [
            {
              personId: athleteId,
              skillId: sessionSkillId,
              status: sessionSkillStatus,
            },
          ],
        }),
        z.null(),
      ),
    onSuccess: async () => {
      setNotice('Session skill progress recorded.');
      await queryClient.invalidateQueries({
        queryKey: ['classes', orgId, 'progress'],
      });
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Skill progress could not be recorded.',
      );
    },
  });
  const recordAthleteSkill = useMutation({
    mutationFn: (input: {
      personId: string;
      skillId: string;
      status: 'not_started' | 'in_progress' | 'achieved';
    }) =>
      apiPost(
        `${base}/people/${encodeURIComponent(input.personId)}/skills`,
        { skillId: input.skillId, status: input.status, note: null },
        z.null(),
      ),
    onSuccess: async () => {
      setNotice('Skill progress saved.');
      await queryClient.invalidateQueries({
        queryKey: ['classes', orgId, 'progress', personId],
      });
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Skill progress could not be saved.',
      );
    },
  });
  const checkIn = useMutation({
    mutationFn: (athlete: string) =>
      apiPost(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/check-in`,
        { personId: athlete },
        checkedInSchema,
      ),
    onSuccess: async () => {
      setNotice('Athlete checked in.');
      await queryClient.invalidateQueries({
        queryKey: ['classes', orgId, 'session', selectedSession, 'roster'],
      });
    },
    onError: (caught) => {
      setError(caught instanceof Error ? caught.message : 'Check-in failed.');
    },
  });
  const checkOut = useMutation({
    mutationFn: (input: { athlete: string; pickup: string }) =>
      apiPost(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/check-out`,
        { personId: input.athlete, pickedUpByPersonId: input.pickup },
        checkedOutSchema,
      ),
    onSuccess: async ({ pickedUpBy }) => {
      setNotice(`Checked out to ${pickedUpBy}.`);
      setSelectedAthlete('');
      await queryClient.invalidateQueries({
        queryKey: ['classes', orgId, 'session', selectedSession, 'roster'],
      });
    },
    onError: (caught) => {
      setError(caught instanceof Error ? caught.message : 'Check-out failed.');
    },
  });
  const assignInstructor = useMutation({
    mutationFn: () =>
      apiPost(
        `${base}/schedules/${encodeURIComponent(selectedSchedule)}/instructors`,
        { personId: selectedInstructor },
        z.strictObject({
          instructor: z.strictObject({
            id: z.uuid(),
            status: z.string(),
            missing: z.array(
              z.looseObject({ code: z.string(), message: z.string() }),
            ),
          }),
        }),
      ),
    onSuccess: async ({ instructor }) => {
      setNotice(
        instructor.status === 'active'
          ? 'Instructor assigned.'
          : `Instructor assignment is pending compliance: ${instructor.missing.map((item) => item.message).join(', ')}`,
      );
      setSelectedInstructor('');
      await queryClient.invalidateQueries({ queryKey: ['classes', orgId] });
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Instructor could not be assigned.',
      );
    },
  });
  const assignSubstitute = useMutation({
    mutationFn: () =>
      apiPost(
        `${base}/sessions/${encodeURIComponent(selectedSession)}/substitute`,
        { personId: selectedSubstitute },
        z.strictObject({
          substitute: z.strictObject({ personId: z.uuid(), name: z.string() }),
        }),
      ),
    onSuccess: async ({ substitute }) => {
      setNotice(`${substitute.name} assigned as a compliant substitute.`);
      setSelectedSubstitute('');
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Substitute instructor could not be assigned.',
      );
    },
  });
  const syncLevels = useMutation({
    mutationFn: (sportProfileId: string) =>
      apiPost(`${base}/levels/sync`, { sportProfileId }, syncResponseSchema),
    onSuccess: async ({ levelsCreated, skillsCreated }) => {
      setNotice(
        `${String(levelsCreated)} levels and ${String(skillsCreated)} skills synchronized.`,
      );
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Sport levels could not be synchronized.',
      );
    },
  });
  const createLevel = useMutation({
    mutationFn: (body: z.output<typeof skillLevelBodySchema>) =>
      apiPost(`${base}/levels`, body, levelResponseSchema, crypto.randomUUID()),
    onSuccess: async () => {
      setNotice('Skill level created.');
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Skill level could not be created.',
      );
    },
  });
  const createSkill = useMutation({
    mutationFn: (input: {
      levelId: string;
      body: z.output<typeof skillBodySchema>;
    }) =>
      apiPost(
        `${base}/levels/${encodeURIComponent(input.levelId)}/skills`,
        input.body,
        skillResponseSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setNotice('Skill added to the level.');
      await queryClient.invalidateQueries({
        queryKey: ['classes', orgId, 'level', levelId],
      });
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error ? caught.message : 'Skill could not be added.',
      );
    },
  });
  const recommendPromotion = useMutation({
    mutationFn: (input: {
      personId: string;
      toLevelId: string;
      note: string;
      targetClassOfferingId: string;
    }) =>
      apiPost(
        `${base}/promotions`,
        input,
        promotionResponseSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setNotice('Promotion recommendation sent to the family for review.');
      setPromotionNote('');
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Promotion could not be recommended.',
      );
    },
  });
  const approvePromotion = useMutation({
    mutationFn: (
      promotion: z.output<typeof promotionListSchema>['items'][number],
    ) =>
      apiPost(
        `${base}/promotions/${encodeURIComponent(promotion.id)}/approve`,
        { expectedVersion: promotion.version },
        promotionDecisionResponseSchema,
      ),
    onSuccess: async () => {
      setNotice('Promotion approved. The guardian was notified.');
      await refreshClasses();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Promotion could not be approved.',
      );
    },
  });

  const offeringRows = offerings.data?.items ?? [];
  const activeOfferings = offeringRows.filter(
    (item) => item.status === 'active',
  );
  const sessionRows = sessions.data?.items ?? [];
  const activePeople = people.data?.items ?? [];
  const promotionRows = promotions.data?.items ?? [];
  const openPromotions = promotionRows.filter(
    (item) => item.status === 'recommended',
  );
  const sessionColumns: Column<Session>[] = useMemo(
    () => [
      {
        key: 'startsAt',
        label: 'Class session',
        render: (item) => (
          <>
            <strong>{item.offeringName}</strong>
            <br />
            {formatWhen(item.startsAt)}
          </>
        ),
        sort: (item) => item.startsAt,
      },
      {
        key: 'instructors',
        label: 'Instructor',
        render: (item) => item.instructorNames.join(', ') || 'Not assigned',
      },
      {
        key: 'capacity',
        label: 'Enrollment / capacity',
        render: (item) =>
          `${String(item.enrolledCount + item.bookedCount)} / ${String(item.capacity)}`,
      },
      {
        key: 'status',
        label: 'Status',
        render: (item) => (
          <Badge tone={item.status === 'scheduled' ? 'ok' : 'neutral'}>
            {item.status}
          </Badge>
        ),
      },
      {
        key: 'action',
        label: 'Attendance',
        render: (item) => (
          <Button
            type="button"
            secondary
            onClick={() => {
              setSelectedSession(item.id);
            }}
          >
            Open roster
          </Button>
        ),
      },
    ],
    [],
  );

  const downloadCertificate = async (promotionId: string): Promise<void> => {
    try {
      const response = await fetch(
        `/api/v1/classes/orgs/${encodeURIComponent(orgId)}/promotions/${encodeURIComponent(promotionId)}/certificate.pdf`,
        { credentials: 'include' },
      );
      if (!response.ok)
        throw new Error(
          'Certificate is available after the promotion is completed.',
        );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `academy-certificate-${promotionId}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Certificate could not be downloaded.',
      );
    }
  };

  return (
    <main className="console-home">
      <PageHeader
        kicker="ACADEMY"
        title="Classes and students"
        description="Manage class schedules, enrollment, attendance, skills and tuition."
      />
      {error && (
        <Banner tone="error" title="Action not completed">
          {error}
        </Banner>
      )}
      {notice && <Banner tone="success">{notice}</Banner>}
      <Tabs
        items={[
          'Overview',
          'Class offerings',
          'Sessions & attendance',
          'Skills & promotions',
          'Tuition',
        ]}
        value={tab}
        onChange={setTab}
        label="Academy sections"
      />

      {tab === 'Overview' && (
        <>
          {dashboard.isLoading ? (
            <p role="status">Loading academy dashboard…</p>
          ) : dashboard.error ? (
            <Banner tone="error">{dashboard.error.message}</Banner>
          ) : (
            dashboard.data && (
              <>
                <section className="academy-stats" aria-label="Academy summary">
                  <StatTile
                    label="Monthly tuition"
                    value={formatMoney(dashboard.data.tuitionMrrCents, 'en-US')}
                    detail={`${String(dashboard.data.activeSubscriptions)} active subscriptions`}
                  />
                  <StatTile
                    label="Active students"
                    value={dashboard.data.enrollmentByLevel.reduce(
                      (sum, level) => sum + level.activeEnrollments,
                      0,
                    )}
                  />
                  <StatTile
                    label="Failed payments"
                    value={dashboard.data.failedPayments30d}
                    detail="Past 30 days"
                    {...(dashboard.data.failedPayments30d
                      ? { trend: 'down' as const }
                      : {})}
                  />
                  <StatTile
                    label="Make-up credits"
                    value={dashboard.data.openMakeupCredits}
                    detail="Available to families"
                  />
                </section>
                {dashboard.data.ratioWarnings.length > 0 && (
                  <Card>
                    <h2>Instructor ratio alerts</h2>
                    <ul>
                      {dashboard.data.ratioWarnings.map((warning) => (
                        <li key={warning.classSessionId}>
                          <strong>{warning.offeringName}</strong> —{' '}
                          {formatWhen(warning.startsAt)}: {warning.attendees}{' '}
                          attendees, {warning.instructors} instructors;{' '}
                          {warning.requiredInstructors} required.
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                <div className="academy-two-col">
                  <Card>
                    <h2>Enrollment by level</h2>
                    <DataTable
                      rows={dashboard.data.enrollmentByLevel.map((item) => ({
                        ...item,
                        id: item.levelId ?? item.levelName,
                      }))}
                      columns={[
                        { key: 'levelName', label: 'Level' },
                        {
                          key: 'activeEnrollments',
                          label: 'Students',
                          sort: (item) => item.activeEnrollments,
                        },
                        {
                          key: 'capacity',
                          label: 'Capacity',
                          sort: (item) => item.capacity,
                        },
                      ]}
                    />
                  </Card>
                  <Card>
                    <h2>Capacity by class</h2>
                    <DataTable
                      rows={dashboard.data.enrollmentByClass.map((item) => ({
                        ...item,
                        id: item.classOfferingId,
                      }))}
                      columns={[
                        { key: 'name', label: 'Class' },
                        { key: 'levelName', label: 'Level' },
                        { key: 'activeEnrollments', label: 'Enrolled' },
                        {
                          key: 'utilizationBps',
                          label: 'Utilization',
                          render: (item) =>
                            `${(item.utilizationBps / 100).toFixed(0)}%`,
                        },
                      ]}
                    />
                  </Card>
                </div>
                <Card>
                  <h2>Capacity heat map · day and hour</h2>
                  {dashboard.data.utilizationHeatmap.length ? (
                    <DataTable
                      rows={dashboard.data.utilizationHeatmap.map(
                        (item, index) => ({
                          ...item,
                          id: `${String(item.weekday)}-${String(item.startHour)}-${String(index)}`,
                        }),
                      )}
                      columns={[
                        {
                          key: 'weekday',
                          label: 'Weekday',
                          render: (item) =>
                            ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][
                              item.weekday - 1
                            ] ?? '—',
                        },
                        {
                          key: 'startHour',
                          label: 'Start hour',
                          render: (item) =>
                            `${String(item.startHour).padStart(2, '0')}:00`,
                        },
                        { key: 'enrolledCount', label: 'Students' },
                        { key: 'capacity', label: 'Capacity' },
                        {
                          key: 'utilizationBps',
                          label: 'Utilization',
                          render: (item) =>
                            `${(item.utilizationBps / 100).toFixed(0)}%`,
                        },
                      ]}
                    />
                  ) : (
                    <EmptyState title="No scheduled classes">
                      Add a class schedule to build the utilization heat map.
                    </EmptyState>
                  )}
                </Card>
                <Card>
                  <h2>Monthly enrollment and withdrawals</h2>
                  {dashboard.data.churn.length ? (
                    <DataTable
                      rows={dashboard.data.churn.map((item) => ({
                        ...item,
                        id: item.month,
                      }))}
                      columns={[
                        {
                          key: 'month',
                          label: 'Month',
                          render: (item) => monthName(item.month),
                        },
                        { key: 'enrollments', label: 'New enrollments' },
                        { key: 'withdrawals', label: 'Withdrawals' },
                      ]}
                    />
                  ) : (
                    <EmptyState>No monthly enrollment history yet.</EmptyState>
                  )}
                </Card>
              </>
            )
          )}
        </>
      )}

      {tab === 'Class offerings' && (
        <div className="academy-two-col">
          <Card>
            <h2>Class offerings</h2>
            {offerings.isLoading ? (
              <p role="status">Loading classes…</p>
            ) : offerings.error ? (
              <Banner tone="error">{offerings.error.message}</Banner>
            ) : (
              <DataTable
                rows={offeringRows}
                columns={[
                  { key: 'name', label: 'Class', sort: (item) => item.name },
                  {
                    key: 'levelName',
                    label: 'Level',
                    render: (item) => item.levelName ?? 'Not set',
                  },
                  { key: 'ageRange', label: 'Age range', render: ageRange },
                  {
                    key: 'priceCents',
                    label: 'Tuition',
                    render: (item) =>
                      `${formatMoney(item.priceCents, 'en-US')} · ${item.billing.replace('_', ' ')}`,
                  },
                  {
                    key: 'capacity',
                    label: 'Spots',
                    render: (item) =>
                      `${String(item.enrolledCount)} / ${String(item.capacity)}`,
                  },
                  {
                    key: 'actions',
                    label: 'Actions',
                    render: (item) => (
                      <div className="academy-actions">
                        <Button
                          type="button"
                          secondary
                          onClick={() => {
                            setEditing(item);
                            setScheduleOffering(null);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          secondary
                          onClick={() => {
                            setScheduleOffering(item);
                            setEditing(null);
                          }}
                        >
                          Schedule
                        </Button>
                        {item.status !== 'archived' && (
                          <Button
                            type="button"
                            secondary
                            disabled={archiveOffering.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Archive ${item.name}? Existing attendance and payment records remain available.`,
                                )
                              )
                                archiveOffering.mutate(item);
                            }}
                          >
                            Archive
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
                empty="Create the first class offering for this program."
              />
            )}
            {scheduleOffering && (
              <Card className="academy-inset">
                <ScheduleForm
                  offering={scheduleOffering}
                  busy={createSchedule.isPending}
                  onSave={(body) => {
                    createSchedule.mutate({ offering: scheduleOffering, body });
                  }}
                />
              </Card>
            )}
            <section className="academy-inset">
              <h3>Schedule instructors</h3>
              {scheduleRows.length === 0 ? (
                <p>Create a class schedule before assigning instructors.</p>
              ) : (
                <>
                  <div className="academy-form-grid">
                    <Field label="Class schedule">
                      <Select
                        value={selectedSchedule}
                        onChange={(event) => {
                          setSelectedSchedule(event.target.value);
                        }}
                      >
                        <option value="">Choose a schedule</option>
                        {scheduleRows.map((schedule) => {
                          const offering = offeringRows.find(
                            (item) => item.id === schedule.classOfferingId,
                          );
                          return (
                            <option key={schedule.id} value={schedule.id}>
                              {offering?.name ?? 'Class'} · {schedule.startTime}{' '}
                              · {schedule.termStart}–{schedule.termEnd}
                            </option>
                          );
                        })}
                      </Select>
                    </Field>
                    <Field label="Instructor">
                      <Select
                        value={selectedInstructor}
                        onChange={(event) => {
                          setSelectedInstructor(event.target.value);
                        }}
                      >
                        <option value="">Choose a person</option>
                        {activePeople.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.firstName} {person.lastName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Button
                    type="button"
                    disabled={
                      !selectedSchedule ||
                      !selectedInstructor ||
                      assignInstructor.isPending
                    }
                    onClick={() => {
                      assignInstructor.mutate();
                    }}
                  >
                    {assignInstructor.isPending
                      ? 'Checking compliance…'
                      : 'Assign instructor'}
                  </Button>
                  {scheduleInstructors.data?.items.map((instructor) => (
                    <p key={instructor.personId}>
                      {instructor.name} · {instructor.status.replace('_', ' ')}
                      {!instructor.eligible && instructor.missing.length > 0
                        ? ` · Missing: ${instructor.missing.map((item) => item.message).join(', ')}`
                        : ''}
                    </p>
                  ))}
                </>
              )}
            </section>
          </Card>
          <Card>
            <OfferingForm
              current={editing}
              levels={levels.data?.items ?? []}
              busy={saveOffering.isPending}
              onCancel={() => {
                setEditing(null);
              }}
              onSave={(body) => {
                saveOffering.mutate(body);
              }}
            />
          </Card>
        </div>
      )}

      {tab === 'Sessions & attendance' && (
        <>
          <Card>
            <h2>Upcoming class sessions</h2>
            <p>
              Sessions from today through {endDate}. Choose a roster to record
              attendance or verify pickup.
            </p>
            {sessions.isLoading ? (
              <p role="status">Loading sessions…</p>
            ) : sessions.error ? (
              <Banner tone="error">{sessions.error.message}</Banner>
            ) : (
              <DataTable
                rows={sessionRows}
                columns={sessionColumns}
                empty="No class sessions are scheduled in this period."
              />
            )}
          </Card>
          {selectedSession && (
            <Card>
              <div className="academy-inline-heading">
                <h2>Attendance roster</h2>
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    setSelectedSession('');
                  }}
                >
                  Close roster
                </Button>
              </div>
              {roster.isLoading ? (
                <p role="status">Loading roster…</p>
              ) : roster.error ? (
                <Banner tone="error">{roster.error.message}</Banner>
              ) : (
                roster.data && (
                  <>
                    <p>
                      <strong>{roster.data.session.offeringName}</strong> ·{' '}
                      {formatWhen(roster.data.session.startsAt)} ·{' '}
                      {roster.data.attendees.length} listed
                    </p>
                    {roster.data.session.status === 'scheduled' &&
                    new Date(roster.data.session.startsAt).getTime() >
                      Date.now() ? (
                      <div className="academy-form-grid academy-substitute">
                        <Field label="Compliant substitute instructor">
                          <Select
                            value={selectedSubstitute}
                            onChange={(event) => {
                              setSelectedSubstitute(event.target.value);
                            }}
                          >
                            <option value="">
                              {roster.data.session.substitutePersonId
                                ? 'Replace current substitute'
                                : 'Choose an instructor'}
                            </option>
                            {activePeople.map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.firstName} {person.lastName}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Button
                          type="button"
                          secondary
                          disabled={
                            !selectedSubstitute || assignSubstitute.isPending
                          }
                          onClick={() => {
                            assignSubstitute.mutate();
                          }}
                        >
                          {assignSubstitute.isPending
                            ? 'Checking compliance…'
                            : 'Assign substitute'}
                        </Button>
                      </div>
                    ) : (
                      <p>
                        {roster.data.session.substitutePersonId
                          ? 'A substitute is assigned for this session.'
                          : 'Substitute assignment is available before the session starts.'}
                      </p>
                    )}
                    <div className="academy-form-grid academy-substitute">
                      <Field label="Session skill level">
                        <Select
                          value={levelId}
                          onChange={(event) => {
                            setLevelId(event.target.value);
                            setSessionSkillId('');
                          }}
                        >
                          <option value="">Choose a level</option>
                          {(levels.data?.items ?? []).map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Skill">
                        <Select
                          value={sessionSkillId}
                          onChange={(event) => {
                            setSessionSkillId(event.target.value);
                          }}
                        >
                          <option value="">Choose a skill</option>
                          {(selectedLevel.data?.level.skills ?? []).map(
                            (item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ),
                          )}
                        </Select>
                      </Field>
                      <Field label="Progress to record">
                        <Select
                          value={sessionSkillStatus}
                          onChange={(event) => {
                            setSessionSkillStatus(
                              event.target.value as typeof sessionSkillStatus,
                            );
                          }}
                        >
                          <option value="in_progress">In progress</option>
                          <option value="achieved">Achieved</option>
                          <option value="not_started">Not started</option>
                        </Select>
                      </Field>
                    </div>
                    <DataTable
                      rows={roster.data.attendees.map((attendee) => ({
                        ...attendee,
                        id: attendee.personId,
                      }))}
                      columns={[
                        {
                          key: 'personName',
                          label: 'Student',
                          sort: (item) => item.personName,
                        },
                        {
                          key: 'membership',
                          label: 'Enrollment type',
                          render: (item) => item.membership.replace('_', ' '),
                        },
                        {
                          key: 'skill',
                          label: 'Skill progress',
                          render: (item) => (
                            <Button
                              type="button"
                              secondary
                              disabled={
                                !sessionSkillId || markSessionSkill.isPending
                              }
                              onClick={() => {
                                markSessionSkill.mutate(item.personId);
                              }}
                            >
                              Record {sessionSkillStatus.replace('_', ' ')}
                            </Button>
                          ),
                        },
                        {
                          key: 'status',
                          label: 'Attendance',
                          render: (item) => (
                            <Select
                              aria-label={`Attendance for ${item.personName}`}
                              value={attendance[item.personId] ?? item.status}
                              onChange={(event) => {
                                setAttendance((current) => ({
                                  ...current,
                                  [item.personId]: event.target.value,
                                }));
                              }}
                            >
                              <option value="present">Present</option>
                              <option value="late">Late</option>
                              <option value="absent">Absent</option>
                              <option value="excused">Excused</option>
                              <option value="unknown">Not marked</option>
                            </Select>
                          ),
                        },
                        {
                          key: 'actions',
                          label: 'Check-in / pickup',
                          render: (item) => (
                            <div className="academy-actions">
                              {!item.checkedInAt && (
                                <Button
                                  type="button"
                                  secondary
                                  onClick={() => {
                                    checkIn.mutate(item.personId);
                                  }}
                                  disabled={checkIn.isPending}
                                >
                                  Check in
                                </Button>
                              )}
                              {item.checkedInAt && !item.checkedOutAt && (
                                <>
                                  <Button
                                    type="button"
                                    secondary
                                    onClick={() => {
                                      setSelectedAthlete(item.personId);
                                    }}
                                  >
                                    Verify pickup
                                  </Button>
                                  {selectedAthlete === item.personId && (
                                    <div className="academy-pickup">
                                      <label
                                        htmlFor={`pickup-${item.personId}`}
                                      >
                                        Authorized pickup
                                      </label>
                                      <Select
                                        id={`pickup-${item.personId}`}
                                        value={selectedPickup}
                                        onChange={(event) => {
                                          setSelectedPickup(event.target.value);
                                        }}
                                      >
                                        <option value="">
                                          Choose a verified pickup person
                                        </option>
                                        {(pickups.data?.items ?? []).map(
                                          (pickup) => (
                                            <option
                                              key={pickup.personId}
                                              value={pickup.personId}
                                            >
                                              {pickup.name}
                                            </option>
                                          ),
                                        )}
                                      </Select>
                                      <Button
                                        type="button"
                                        disabled={
                                          !selectedPickup || checkOut.isPending
                                        }
                                        onClick={() => {
                                          checkOut.mutate({
                                            athlete: item.personId,
                                            pickup: selectedPickup,
                                          });
                                        }}
                                      >
                                        Check out
                                      </Button>
                                    </div>
                                  )}
                                </>
                              )}
                              {item.checkedOutAt && (
                                <Badge tone="confirmed">
                                  Picked up by{' '}
                                  {item.pickedUpByName ?? 'authorized adult'}
                                </Badge>
                              )}
                            </div>
                          ),
                        },
                      ]}
                      empty="No enrolled students are on this session roster."
                    />
                    <Button
                      type="button"
                      disabled={
                        markAttendance.isPending ||
                        !roster.data.attendees.length
                      }
                      onClick={() => {
                        markAttendance.mutate();
                      }}
                    >
                      {markAttendance.isPending
                        ? 'Saving…'
                        : 'Save attendance and issue make-up credits'}
                    </Button>
                  </>
                )
              )}
            </Card>
          )}
        </>
      )}

      {tab === 'Skills & promotions' && (
        <div className="academy-two-col">
          <Card>
            <h2>Skill levels and skills</h2>
            {levels.isLoading ? (
              <p role="status">Loading levels…</p>
            ) : levels.error ? (
              <Banner tone="error">{levels.error.message}</Banner>
            ) : (
              <DataTable
                rows={levels.data?.items ?? []}
                columns={[
                  { key: 'name', label: 'Level' },
                  { key: 'sortOrder', label: 'Order' },
                  { key: 'skillCount', label: 'Skills' },
                  {
                    key: 'id',
                    label: 'Detail',
                    render: (item) => (
                      <Button
                        type="button"
                        secondary
                        onClick={() => {
                          setLevelId(item.id);
                        }}
                      >
                        Manage skills
                      </Button>
                    ),
                  },
                ]}
                empty="Synchronize a sport profile or add levels by hand."
              />
            )}
            <form
              className="academy-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const parsed = skillLevelBodySchema.safeParse({
                  sportProfileId: data.get('sportProfileId'),
                  name: data.get('name'),
                  description: null,
                  sortOrder: Number(data.get('sortOrder')),
                });
                if (parsed.success) createLevel.mutate(parsed.data);
                else
                  setError(
                    parsed.error.issues[0]?.message ??
                      'Enter a valid skill level.',
                  );
              }}
            >
              <h3>Add a skill level</h3>
              <Field label="Sport profile ID" required>
                <Input name="sportProfileId" type="text" required />
              </Field>
              <Field label="Level name" required>
                <Input name="name" required />
              </Field>
              <Field label="Order" required>
                <Input
                  name="sortOrder"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue="1"
                  required
                />
              </Field>
              <Button disabled={createLevel.isPending}>Add level</Button>
            </form>
            <form
              className="academy-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const parsed = skillBodySchema.safeParse({
                  name: data.get('name'),
                  description: data.get('description') || null,
                  videoUrl: data.get('videoUrl') || null,
                  sortOrder: Number(data.get('sortOrder')),
                });
                if (parsed.success && levelId)
                  createSkill.mutate({ levelId, body: parsed.data });
                else
                  setError(
                    parsed.success
                      ? 'Choose a level before adding a skill.'
                      : (parsed.error.issues[0]?.message ??
                          'Enter a valid skill.'),
                  );
              }}
            >
              <h3>Add a skill to the selected level</h3>
              <Field label="Selected level">
                <Select
                  value={levelId}
                  onChange={(event) => {
                    setLevelId(event.target.value);
                  }}
                >
                  <option value="">Choose a level</option>
                  {(levels.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Skill name" required>
                <Input name="name" required />
              </Field>
              <Field label="Description">
                <Input name="description" />
              </Field>
              <Field label="Video link">
                <Input name="videoUrl" type="url" />
              </Field>
              <Field label="Order" required>
                <Input
                  name="sortOrder"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue="1"
                  required
                />
              </Field>
              <Button disabled={createSkill.isPending || !levelId}>
                Add skill
              </Button>
            </form>
            {levelId && selectedLevel.data && (
              <>
                <h3>{selectedLevel.data.level.name} skill list</h3>
                <ul>
                  {selectedLevel.data.level.skills.map((item) => (
                    <li key={item.id}>{item.name}</li>
                  ))}
                </ul>
              </>
            )}
            <form
              className="academy-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const idValue = data.get('sportProfileId');
                const id = typeof idValue === 'string' ? idValue.trim() : '';
                if (z.uuid().safeParse(id).success) syncLevels.mutate(id);
                else setError('Enter a valid sport profile ID.');
              }}
            >
              <h3>Sync skills from sport profile</h3>
              <Field
                label="Sport profile ID"
                required
                hint="Copies the profile’s academy levels and skills into this organization."
              >
                <Input name="sportProfileId" required />
              </Field>
              <Button secondary disabled={syncLevels.isPending}>
                Sync sport profile
              </Button>
            </form>
          </Card>
          <Card>
            <h2>Track an athlete’s skill</h2>
            <form
              className="academy-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const parsed = z
                  .object({
                    personId: z.uuid(),
                    skillId: z.uuid(),
                    status: z.enum(['not_started', 'in_progress', 'achieved']),
                    note: z.string().max(500).nullable(),
                  })
                  .safeParse({
                    personId,
                    skillId,
                    status: data.get('status'),
                    note: null,
                  });
                if (!parsed.success) {
                  setError('Choose a student and skill.');
                  return;
                }
                recordAthleteSkill.mutate(parsed.data);
              }}
            >
              <Field label="Student" required>
                <Select
                  value={personId}
                  onChange={(event) => {
                    setPersonId(event.target.value);
                  }}
                >
                  <option value="">Choose a student</option>
                  {activePeople.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.firstName} {person.lastName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Level" required>
                <Select
                  value={levelId}
                  onChange={(event) => {
                    setLevelId(event.target.value);
                    setSkillId('');
                  }}
                >
                  <option value="">Choose a level</option>
                  {(levels.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Skill" required>
                <Select
                  value={skillId}
                  onChange={(event) => {
                    setSkillId(event.target.value);
                  }}
                >
                  <option value="">Choose a skill</option>
                  {(selectedLevel.data?.level.skills ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Progress" required>
                <Select name="status">
                  <option value="in_progress">In progress</option>
                  <option value="achieved">Achieved</option>
                  <option value="not_started">Not started</option>
                </Select>
              </Field>
              <Button
                disabled={!personId || !skillId || recordAthleteSkill.isPending}
              >
                {recordAthleteSkill.isPending ? 'Saving…' : 'Save progress'}
              </Button>
            </form>
            <h2>Promotion recommendations</h2>
            <form
              className="academy-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!personId || !levelId || !promotionOfferingId) {
                  setError(
                    'Choose a student, destination level and next class.',
                  );
                  return;
                }
                recommendPromotion.mutate({
                  personId,
                  toLevelId: levelId,
                  note: promotionNote || '',
                  targetClassOfferingId: promotionOfferingId,
                });
              }}
            >
              <Field label="Student" required>
                <Select
                  value={personId}
                  onChange={(event) => {
                    setPersonId(event.target.value);
                  }}
                >
                  <option value="">Choose a student</option>
                  {activePeople.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.firstName} {person.lastName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Next level" required>
                <Select
                  value={levelId}
                  onChange={(event) => {
                    setLevelId(event.target.value);
                    setPromotionOfferingId('');
                  }}
                >
                  <option value="">Choose a level</option>
                  {(levels.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Next class" required>
                <Select
                  value={promotionOfferingId}
                  onChange={(event) => {
                    setPromotionOfferingId(event.target.value);
                  }}
                >
                  <option value="">Choose a class at the next level</option>
                  {activeOfferings
                    .filter((item) => item.skillLevelId === levelId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Message for family">
                <Textarea
                  value={promotionNote}
                  onChange={(event) => {
                    setPromotionNote(event.target.value);
                  }}
                  maxLength={500}
                />
              </Field>
              <Button
                disabled={
                  recommendPromotion.isPending ||
                  !personId ||
                  !levelId ||
                  !promotionOfferingId
                }
              >
                Recommend promotion
              </Button>
            </form>
            <h3>Awaiting staff approval</h3>
            {openPromotions.length ? (
              <DataTable
                rows={openPromotions}
                columns={[
                  { key: 'personName', label: 'Student' },
                  { key: 'toLevelName', label: 'Recommended level' },
                  {
                    key: 'note',
                    label: 'Note',
                    render: (item) => item.note ?? '—',
                  },
                  {
                    key: 'action',
                    label: 'Action',
                    render: (item) => (
                      <Button
                        type="button"
                        disabled={approvePromotion.isPending}
                        onClick={() => {
                          approvePromotion.mutate(item);
                        }}
                      >
                        Approve and notify family
                      </Button>
                    ),
                  },
                ]}
              />
            ) : (
              <EmptyState>No recommendations need approval.</EmptyState>
            )}
            <h3>Completed certificates</h3>
            {promotionRows.some((item) => item.status === 'completed') ? (
              <ul>
                {promotionRows
                  .filter((item) => item.status === 'completed')
                  .map((item) => (
                    <li key={item.id}>
                      {item.personName} · {item.toLevelName}{' '}
                      <Button
                        type="button"
                        secondary
                        onClick={() => void downloadCertificate(item.id)}
                      >
                        Download certificate
                      </Button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No certificates have been issued yet.</p>
            )}
          </Card>
        </div>
      )}

      {tab === 'Tuition' && (
        <>
          <Card>
            <h2>Tuition subscriptions</h2>
            <p>
              Monthly invoices are generated by the academy tuition job and
              charged through the organization’s finance service.
            </p>
            {subscriptions.isLoading ? (
              <p role="status">Loading subscriptions…</p>
            ) : subscriptions.error ? (
              <Banner tone="error">{subscriptions.error.message}</Banner>
            ) : (
              <DataTable
                rows={subscriptions.data?.items ?? []}
                columns={[
                  {
                    key: 'householdName',
                    label: 'Household',
                    sort: (item) => item.householdName,
                  },
                  {
                    key: 'activeEnrollments',
                    label: 'Students',
                    sort: (item) => item.activeEnrollments,
                  },
                  {
                    key: 'status',
                    label: 'Status',
                    render: (item) => (
                      <Badge
                        tone={
                          item.status === 'active' ? 'confirmed' : 'neutral'
                        }
                      >
                        {item.status}
                      </Badge>
                    ),
                  },
                  {
                    key: 'billingDay',
                    label: 'Billing day',
                    render: (item) => `${String(item.billingDay)} of the month`,
                  },
                  {
                    key: 'nextBillOn',
                    label: 'Next bill',
                    sort: (item) => item.nextBillOn,
                  },
                  {
                    key: 'proration',
                    label: 'Proration',
                    render: (item) => item.proration.replaceAll('_', ' '),
                  },
                ]}
                empty="No tuition subscriptions yet."
              />
            )}
          </Card>
          <Card>
            <h2>Withdrawals by month</h2>
            <DataTable
              rows={(dashboard.data?.churn ?? []).map((item) => ({
                ...item,
                id: item.month,
              }))}
              columns={[
                {
                  key: 'month',
                  label: 'Month',
                  render: (item) => monthName(item.month),
                },
                { key: 'enrollments', label: 'New students' },
                { key: 'withdrawals', label: 'Withdrawals' },
              ]}
              empty="There is no withdrawal history yet."
            />
          </Card>
        </>
      )}
    </main>
  );
}
