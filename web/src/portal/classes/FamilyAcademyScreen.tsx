import {
  athleteProgressSchema,
  bookingResultSchema,
  browseClassListSchema,
  classEnrollmentListSchema,
  classSessionListSchema,
  enrollResultSchema,
  enrollBodySchema,
  makeupCreditListSchema,
  pauseBodySchema,
  punchCardListSchema,
  promotionDecisionSchema,
  promotionListSchema,
  resumeBodySchema,
  tuitionSubscriptionListSchema,
  waitlistListSchema,
  withdrawBodySchema,
} from '@shared/schemas/classes';
import { familyResponseSchema } from '@shared/schemas/people';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Tabs,
} from '../../ui';

import '../../console/classes/classes.css';

const methodsSchema = z.strictObject({
  methods: z.array(
    z.strictObject({
      id: z.string().startsWith('pm_'),
      type: z.enum(['card', 'us_bank_account', 'link']),
      brand: z.string().nullable(),
      last4: z.string().nullable(),
      bankName: z.string().nullable(),
    }),
  ),
  defaultMethodId: z.string().startsWith('pm_').nullable(),
});
const enrollmentResponseSchema = z.strictObject({
  enrollment: classEnrollmentListSchema.shape.items.element,
});
const promotionResponseSchema = z.strictObject({
  promotion: promotionListSchema.shape.items.element,
});
const progressResponseSchema = athleteProgressSchema;
const subscriptionResponseSchema = z.strictObject({
  subscription: tuitionSubscriptionListSchema.shape.items.element,
});

function todayString(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function futureDate(days: number): string {
  const value = new Date(`${todayString()}T12:00:00`);
  value.setDate(value.getDate() + days);
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function methodName(
  method: z.output<typeof methodsSchema>['methods'][number],
): string {
  if (method.type === 'us_bank_account')
    return `${method.bankName ?? 'Bank account'} ending ${method.last4 ?? 'unknown'}`;
  if (method.type === 'card')
    return `${method.brand ?? 'Card'} ending ${method.last4 ?? 'unknown'}`;
  return `Link ending ${method.last4 ?? 'unknown'}`;
}

export function FamilyAcademyScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/classes/orgs/${encodeURIComponent(orgId)}`;
  const client = useQueryClient();
  const [tab, setTab] = useState('Classes');
  const [personId, setPersonId] = useState('');
  const [startsOn, setStartsOn] = useState(todayString());
  const [classesPerWeek, setClassesPerWeek] = useState(1);
  const [trial, setTrial] = useState(false);
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [autopay, setAutopay] = useState(false);
  const [billingDay, setBillingDay] = useState(1);
  const [dayFilter, setDayFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState('');
  const [pauseFrom, setPauseFrom] = useState(todayString());
  const [pauseTo, setPauseTo] = useState(futureDate(14));
  const [creditId, setCreditId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [bookingOfferingId, setBookingOfferingId] = useState('');
  const [bookingSessionId, setBookingSessionId] = useState('');
  const [punchCardId, setPunchCardId] = useState('');
  const [promotionTargets, setPromotionTargets] = useState<
    Record<string, string>
  >({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [paymentNotice, setPaymentNotice] = useState('');

  const family = useQuery({
    queryKey: ['people', 'me', 'family'],
    queryFn: () => apiGet('/people/me/family', familyResponseSchema),
  });
  const organization = family.data?.organizations.find(
    (item) => item.orgId === orgId,
  );
  const familyPeople = useMemo(
    () => organization?.people ?? [],
    [organization?.people],
  );
  useEffect(() => {
    if (!personId && familyPeople.length)
      setPersonId(familyPeople[0]?.personId ?? '');
  }, [familyPeople, personId]);

  const offerings = useQuery({
    queryKey: ['classes', orgId, 'family-browse', personId, dayFilter],
    queryFn: () =>
      apiGet(
        `${base}/me/browse?personId=${encodeURIComponent(personId)}${dayFilter ? `&day=${encodeURIComponent(dayFilter)}` : ''}`,
        browseClassListSchema,
      ),
    enabled: Boolean(personId),
  });
  const enrollments = useQuery({
    queryKey: ['classes', orgId, 'family-enrollments', personId],
    queryFn: () =>
      apiGet(
        `${base}/me/enrollments?personId=${encodeURIComponent(personId)}&limit=200`,
        classEnrollmentListSchema,
      ),
    enabled: Boolean(personId),
  });
  const credits = useQuery({
    queryKey: ['classes', orgId, 'family-makeup-credits', personId],
    queryFn: () =>
      apiGet(
        `${base}/me/makeup-credits?personId=${encodeURIComponent(personId)}`,
        makeupCreditListSchema,
      ),
    enabled: Boolean(personId),
  });
  const waitlist = useQuery({
    queryKey: ['classes', orgId, 'family-waitlist', personId],
    queryFn: () =>
      apiGet(
        `${base}/me/waitlist?personId=${encodeURIComponent(personId)}`,
        waitlistListSchema,
      ),
    enabled: Boolean(personId),
  });
  const punchCards = useQuery({
    queryKey: ['classes', orgId, 'family-punch-cards', personId],
    queryFn: () =>
      apiGet(
        `${base}/me/punch-cards?personId=${encodeURIComponent(personId)}`,
        punchCardListSchema,
      ),
    enabled: Boolean(personId),
  });
  const selectedCredit = credits.data?.items.find(
    (item) => item.id === creditId,
  );
  const sessionFrom = todayString();
  const sessionTo = futureDate(60);
  const sessions = useQuery({
    queryKey: [
      'classes',
      orgId,
      'family-sessions',
      selectedCredit?.classOfferingId,
      sessionFrom,
      sessionTo,
    ],
    queryFn: () =>
      apiGet(
        `${base}/me/makeup-credits/${encodeURIComponent(selectedCredit?.id ?? '')}/sessions?from=${sessionFrom}&to=${sessionTo}&limit=200`,
        classSessionListSchema,
      ),
    enabled: Boolean(selectedCredit),
  });
  const bookingSessions = useQuery({
    queryKey: [
      'classes',
      orgId,
      'family-booking-sessions',
      bookingOfferingId,
      sessionFrom,
      sessionTo,
    ],
    queryFn: () =>
      apiGet(
        `${base}/me/sessions?offeringId=${encodeURIComponent(bookingOfferingId)}&from=${sessionFrom}&to=${sessionTo}&limit=200`,
        classSessionListSchema,
      ),
    enabled: Boolean(bookingOfferingId),
  });
  const progress = useQuery({
    queryKey: ['classes', orgId, 'family-progress', personId],
    queryFn: () =>
      apiGet(
        `${base}/people/${encodeURIComponent(personId)}/progress`,
        progressResponseSchema,
      ),
    enabled: Boolean(personId),
  });
  const promotions = useQuery({
    queryKey: ['classes', orgId, 'family-promotions'],
    queryFn: () => apiGet(`${base}/me/promotions`, promotionListSchema),
  });
  const subscriptions = useQuery({
    queryKey: ['classes', orgId, 'family-subscriptions'],
    queryFn: () =>
      apiGet(`${base}/me/subscriptions`, tuitionSubscriptionListSchema),
  });
  const methods = useQuery({
    queryKey: ['finance', 'me', 'payment-methods'],
    queryFn: () => apiGet('/finance/me/payment-methods', methodsSchema),
  });
  useEffect(() => {
    if (!paymentMethodId && methods.data?.defaultMethodId)
      setPaymentMethodId(methods.data.defaultMethodId);
  }, [methods.data, paymentMethodId]);

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['classes', orgId] });
  };
  const enroll = useMutation({
    mutationFn: (input: { classOfferingId: string; trial: boolean }) =>
      apiPost(
        `${base}/me/enrollments`,
        {
          classOfferingId: input.classOfferingId,
          personId,
          startsOn,
          classesPerWeek,
          trial: input.trial,
          trialSessionId: null,
          paymentMethodId: paymentMethodId || null,
          autopay,
          billingDay,
        },
        enrollResultSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async (result) => {
      setError('');
      if (result.waitlistEntry)
        setNotice(
          `You are on the waitlist at position ${String(result.waitlistEntry.position)}.`,
        );
      else if (result.enrollment)
        setNotice(
          `${result.enrollment.personName} is enrolled in ${result.enrollment.offeringName}.`,
        );
      setPaymentNotice(
        result.invoiceId
          ? `An invoice was created for ${String(result.amountDueCents ?? 0)} cents.`
          : '',
      );
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Enrollment could not be completed.',
      );
    },
  });
  const withdraw = useMutation({
    mutationFn: (
      enrollment: z.output<typeof classEnrollmentListSchema>['items'][number],
    ) =>
      apiPost(
        `${base}/me/enrollments/${encodeURIComponent(enrollment.id)}/withdraw`,
        withdrawBodySchema.parse({
          reason: 'Family requested withdrawal',
          expectedVersion: enrollment.version,
        }),
        z.strictObject({
          enrollment: enrollmentResponseSchema.shape.enrollment,
          billThrough: z.iso.date(),
          refundCents: z.number().int().nonnegative(),
        }),
        crypto.randomUUID(),
      ),
    onSuccess: async ({ billThrough, refundCents }) => {
      setNotice(
        `Withdrawal scheduled through ${billThrough}. Refund due: ${String(refundCents)} cents.`,
      );
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Withdrawal could not be completed.',
      );
    },
  });
  const pause = useMutation({
    mutationFn: (
      enrollment: z.output<typeof classEnrollmentListSchema>['items'][number],
    ) =>
      apiPost(
        `${base}/me/enrollments/${encodeURIComponent(enrollment.id)}/pause`,
        pauseBodySchema.parse({
          pauseFrom,
          pauseTo,
          expectedVersion: enrollment.version,
        }),
        enrollmentResponseSchema,
      ),
    onSuccess: async ({ enrollment }) => {
      setNotice(
        `${enrollment.offeringName} is paused from ${enrollment.pauseFrom ?? ''} through ${enrollment.pauseTo ?? ''}.`,
      );
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Pause could not be requested.',
      );
    },
  });
  const resume = useMutation({
    mutationFn: (
      enrollment: z.output<typeof classEnrollmentListSchema>['items'][number],
    ) =>
      apiPost(
        `${base}/me/enrollments/${encodeURIComponent(enrollment.id)}/resume`,
        resumeBodySchema.parse({ expectedVersion: enrollment.version }),
        enrollmentResponseSchema,
      ),
    onSuccess: async ({ enrollment }) => {
      setNotice(`${enrollment.offeringName} resumed.`);
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Enrollment could not be resumed.',
      );
    },
  });
  const bookMakeup = useMutation({
    mutationFn: () =>
      apiPost(
        `${base}/me/makeup-credits/${encodeURIComponent(creditId)}/book`,
        { creditId, classSessionId: sessionId },
        bookingResultSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setNotice('Make-up class booked.');
      setSessionId('');
      setCreditId('');
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Make-up class could not be booked.',
      );
    },
  });
  const buyPunchCard = useMutation({
    mutationFn: (classOfferingId: string) =>
      apiPost(
        `${base}/me/punch-cards`,
        { classOfferingId, personId },
        z.strictObject({
          punchCardId: z.uuid(),
          invoiceId: z.uuid(),
          amountCents: z.number().int().nonnegative(),
        }),
        crypto.randomUUID(),
      ),
    onSuccess: async ({ amountCents }) => {
      setNotice('Punch card purchased.');
      setPaymentNotice(
        `An invoice was created for ${String(amountCents)} cents.`,
      );
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Punch card could not be purchased.',
      );
    },
  });
  const bookDropIn = useMutation({
    mutationFn: () =>
      apiPost(
        `${base}/me/drop-in`,
        { classSessionId: bookingSessionId, personId },
        bookingResultSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async ({ amountDueCents, invoiceId }) => {
      setNotice('Drop-in session booked.');
      setPaymentNotice(
        invoiceId
          ? `An invoice was created for ${String(amountDueCents ?? 0)} cents.`
          : '',
      );
      setBookingSessionId('');
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Drop-in session could not be booked.',
      );
    },
  });
  const bookPunchCard = useMutation({
    mutationFn: () =>
      apiPost(
        `${base}/me/punch-cards/${encodeURIComponent(punchCardId)}/book`,
        { classSessionId: bookingSessionId },
        bookingResultSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setNotice('Punch card used to book the class session.');
      setBookingSessionId('');
      setPunchCardId('');
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Punch card booking could not be completed.',
      );
    },
  });
  const acceptWaitlist = useMutation({
    mutationFn: (entry: z.output<typeof waitlistListSchema>['items'][number]) =>
      apiPost(
        `${base}/me/waitlist/${encodeURIComponent(entry.id)}/accept`,
        enrollBodySchema.parse({
          classOfferingId: entry.classOfferingId,
          personId: entry.personId,
          householdId: entry.householdId,
          startsOn,
          classesPerWeek,
          trial: false,
          trialSessionId: null,
          paymentMethodId: paymentMethodId || null,
          autopay,
          billingDay,
        }),
        enrollResultSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async ({ enrollment }) => {
      setNotice(
        enrollment
          ? `${enrollment.personName} is enrolled from the waitlist offer.`
          : 'Waitlist offer could not be accepted.',
      );
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Waitlist offer could not be accepted.',
      );
    },
  });
  const declineWaitlist = useMutation({
    mutationFn: (id: string) =>
      apiPost(
        `${base}/me/waitlist/${encodeURIComponent(id)}/decline`,
        {},
        z.null(),
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setNotice('Waitlist offer declined.');
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Waitlist offer could not be declined.',
      );
    },
  });
  const decidePromotion = useMutation({
    mutationFn: (input: {
      id: string;
      version: number;
      offeringId: string | null;
      decline: boolean;
    }) =>
      apiPost(
        `${base}/me/promotions/${encodeURIComponent(input.id)}/${input.decline ? 'decline' : 'confirm'}`,
        input.decline
          ? { expectedVersion: input.version }
          : promotionDecisionSchema.parse({
              expectedVersion: input.version,
              targetClassOfferingId: input.offeringId,
            }),
        promotionResponseSchema,
        crypto.randomUUID(),
      ),
    onSuccess: async ({ promotion }) => {
      setNotice(
        promotion.status === 'declined'
          ? 'Promotion declined.'
          : 'Promotion accepted by your family.',
      );
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Promotion decision could not be saved.',
      );
    },
  });
  const updateSubscription = useMutation({
    mutationFn: (input: {
      subscription: z.output<
        typeof tuitionSubscriptionListSchema
      >['items'][number];
      stopAutopay: boolean;
    }) =>
      apiPatch(
        `${base}/me/subscriptions/${encodeURIComponent(input.subscription.id)}`,
        input.stopAutopay
          ? {
              paymentMethodId: null,
              autopayConsent: false,
              expectedVersion: input.subscription.version,
            }
          : {
              paymentMethodId,
              ...(autopay ? { autopayConsent: true } : {}),
              expectedVersion: input.subscription.version,
            },
        subscriptionResponseSchema,
      ),
    onSuccess: async (_result, input) => {
      setNotice(
        input.stopAutopay
          ? 'Future automatic tuition charges have been stopped.'
          : 'Payment settings updated.',
      );
      setAutopay(false);
      await refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Payment settings could not be updated.',
      );
    },
  });

  const filteredOfferings =
    offerings.data?.items.filter(
      (offering) =>
        (!levelFilter || offering.levelName === levelFilter) &&
        (!timeFilter ||
          offering.meetingTimes.some((time) => time.startTime >= timeFilter)),
    ) ?? [];

  const activeEnrollments = useMemo(
    () =>
      enrollments.data?.items.filter((item) =>
        ['active', 'trial', 'paused'].includes(item.status),
      ) ?? [],
    [enrollments.data],
  );
  const availableCredits =
    credits.data?.items.filter((item) => item.status === 'available') ?? [];
  const paymentLink = `/portal/orgs/${encodeURIComponent(orgId)}/money/invoices`;
  const downloadCertificate = async (promotionId: string): Promise<void> => {
    try {
      const response = await fetch(
        `/api/v1/classes/orgs/${encodeURIComponent(orgId)}/promotions/${encodeURIComponent(promotionId)}/certificate.pdf`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error('Certificate could not be downloaded.');
      const url = URL.createObjectURL(await response.blob());
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
        kicker="FAMILY ACADEMY"
        title="Classes and progress"
        description="Find classes, manage enrollment, book make-ups and follow each athlete’s progress."
      />
      {error && (
        <Banner tone="error" title="Action not completed">
          {error}
        </Banner>
      )}
      {notice && <Banner tone="success">{notice}</Banner>}
      {paymentNotice && (
        <Banner tone="warning">
          {paymentNotice} <a href={paymentLink}>Open payments</a>
        </Banner>
      )}
      {family.isLoading ? (
        <p role="status">Loading family profiles…</p>
      ) : family.error ? (
        <Banner tone="error">{family.error.message}</Banner>
      ) : familyPeople.length === 0 ? (
        <EmptyState title="No family profiles are linked">
          Link a student to your account before enrolling in classes.
        </EmptyState>
      ) : (
        <>
          <Field label="Student">
            <Select
              value={personId}
              onChange={(event) => {
                setPersonId(event.target.value);
                setCreditId('');
              }}
              aria-label="Choose a student"
            >
              {familyPeople.map((person) => (
                <option key={person.personId} value={person.personId}>
                  {person.firstName} {person.lastName}
                </option>
              ))}
            </Select>
          </Field>
          <Tabs
            items={[
              'Classes',
              'My enrollments',
              'Make-up and bookings',
              'Skills and promotions',
              'Tuition',
            ]}
            value={tab}
            onChange={setTab}
            label="Family academy pages"
          />
          {tab === 'Classes' && (
            <div className="academy-two-col">
              <Card>
                <h2>Available classes</h2>
                <p>Results are filtered for the selected student’s age.</p>
                <div className="academy-form-grid">
                  <Field label="Level">
                    <Select
                      value={levelFilter}
                      onChange={(event) => {
                        setLevelFilter(event.target.value);
                      }}
                    >
                      <option value="">All levels</option>
                      {[
                        ...new Set(
                          (offerings.data?.items ?? []).flatMap((item) =>
                            item.levelName ? [item.levelName] : [],
                          ),
                        ),
                      ].map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Day">
                    <Select
                      value={dayFilter}
                      onChange={(event) => {
                        setDayFilter(event.target.value);
                      }}
                    >
                      <option value="">Any day</option>
                      {[
                        ['MO', 'Monday'],
                        ['TU', 'Tuesday'],
                        ['WE', 'Wednesday'],
                        ['TH', 'Thursday'],
                        ['FR', 'Friday'],
                        ['SA', 'Saturday'],
                        ['SU', 'Sunday'],
                      ].map(([day, name]) => (
                        <option key={day} value={day}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Earliest start time">
                    <Input
                      type="time"
                      value={timeFilter}
                      onChange={(event) => {
                        setTimeFilter(event.target.value);
                      }}
                    />
                  </Field>
                </div>
                {offerings.isLoading ? (
                  <p role="status">Searching classes…</p>
                ) : offerings.error ? (
                  <Banner tone="error">{offerings.error.message}</Banner>
                ) : filteredOfferings.length ? (
                  <div className="academy-card-list">
                    {filteredOfferings.map((offering) => (
                      <article
                        className="academy-inset"
                        key={offering.classOfferingId}
                      >
                        <h3>{offering.name}</h3>
                        <p>
                          {offering.programName}
                          {offering.levelName ? ` · ${offering.levelName}` : ''}
                        </p>
                        {offering.description && <p>{offering.description}</p>}
                        <p>
                          {offering.spotsRemaining
                            ? `${String(offering.spotsRemaining)} spots available`
                            : `Waitlist · ${String(offering.waitlistCount)} waiting`}{' '}
                          ·{' '}
                          {offering.meetingTimes
                            .map((time) => `${time.weekday} ${time.startTime}`)
                            .join(', ') || 'Schedule pending'}
                        </p>
                        <p>
                          {offering.billing.replace('_', ' ')} ·{' '}
                          {trial && offering.trialAllowed
                            ? `Trial · ${String(offering.trialPriceCents)} cents`
                            : `${String(offering.priceCents)} cents`}
                        </p>
                        {offering.billing === 'monthly' ||
                        offering.billing === 'term' ? (
                          <Button
                            type="button"
                            disabled={
                              enroll.isPending ||
                              !startsOn ||
                              (autopay && !paymentMethodId)
                            }
                            onClick={() => {
                              enroll.mutate({
                                classOfferingId: offering.classOfferingId,
                                trial: trial && offering.trialAllowed,
                              });
                            }}
                          >
                            {enroll.isPending
                              ? 'Submitting…'
                              : offering.spotsRemaining
                                ? 'Enroll student'
                                : 'Join waitlist'}
                          </Button>
                        ) : offering.billing === 'drop_in' ? (
                          <Button
                            type="button"
                            secondary
                            onClick={() => {
                              setBookingOfferingId(offering.classOfferingId);
                              setBookingSessionId('');
                              setTab('Make-up and bookings');
                            }}
                          >
                            Choose a drop-in session
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            secondary
                            disabled={buyPunchCard.isPending}
                            onClick={() => {
                              buyPunchCard.mutate(offering.classOfferingId);
                            }}
                          >
                            {buyPunchCard.isPending
                              ? 'Purchasing…'
                              : `Buy ${offering.name} punch card`}
                          </Button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No classes available">
                    Ask the organization about upcoming classes or check again
                    later.
                  </EmptyState>
                )}
              </Card>
              <Card>
                <h2>Enrollment details</h2>
                <div className="academy-form">
                  <Field label="Start date" required>
                    <Input
                      type="date"
                      value={startsOn}
                      onChange={(event) => {
                        setStartsOn(event.target.value);
                      }}
                    />
                  </Field>
                  <Field label="Classes per week" required>
                    <Input
                      type="number"
                      min="1"
                      max="14"
                      step="1"
                      value={classesPerWeek}
                      onChange={(event) => {
                        setClassesPerWeek(Number(event.target.value));
                      }}
                    />
                  </Field>
                  <label className="academy-check">
                    <input
                      type="checkbox"
                      checked={trial}
                      onChange={(event) => {
                        setTrial(event.target.checked);
                      }}
                    />
                    <span>Request an offered trial class</span>
                  </label>
                  {trial && (
                    <p>
                      Trial availability and price depend on the class. Staff
                      will confirm details if the selected class supports
                      trials.
                    </p>
                  )}
                  <Field label="Saved payment method">
                    <Select
                      value={paymentMethodId}
                      onChange={(event) => {
                        setPaymentMethodId(event.target.value);
                      }}
                    >
                      <option value="">Pay invoices manually</option>
                      {(methods.data?.methods ?? []).map((method) => (
                        <option key={method.id} value={method.id}>
                          {methodName(method)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {methods.data?.methods.length === 0 && (
                    <p>
                      <a
                        href={`/portal/orgs/${encodeURIComponent(orgId)}/money/autopay`}
                      >
                        Add a saved payment method
                      </a>{' '}
                      to enable automatic tuition payments.
                    </p>
                  )}
                  <Field label="Billing day (monthly tuition)">
                    <Input
                      type="number"
                      min="1"
                      max="28"
                      step="1"
                      value={billingDay}
                      onChange={(event) => {
                        setBillingDay(Number(event.target.value));
                      }}
                    />
                  </Field>
                  <label className="academy-check">
                    <input
                      type="checkbox"
                      checked={autopay}
                      onChange={(event) => {
                        setAutopay(event.target.checked);
                      }}
                    />
                    <span>
                      I authorize future tuition charges to my selected saved
                      payment method.
                    </span>
                  </label>
                </div>
              </Card>
            </div>
          )}
          {tab === 'My enrollments' && (
            <Card>
              <h2>Current and past enrollments</h2>
              {enrollments.isLoading ? (
                <p role="status">Loading enrollments…</p>
              ) : enrollments.error ? (
                <Banner tone="error">{enrollments.error.message}</Banner>
              ) : activeEnrollments.length ? (
                <div className="academy-card-list">
                  {activeEnrollments.map((enrollment) => (
                    <article className="academy-inset" key={enrollment.id}>
                      <div className="academy-inline-heading">
                        <h3>{enrollment.offeringName}</h3>
                        <Badge
                          tone={
                            enrollment.status === 'active'
                              ? 'confirmed'
                              : 'neutral'
                          }
                        >
                          {enrollment.status}
                        </Badge>
                      </div>
                      <p>
                        {enrollment.personName} · starts {enrollment.startsOn}
                        {enrollment.pauseFrom
                          ? ` · paused ${enrollment.pauseFrom} through ${enrollment.pauseTo ?? ''}`
                          : ''}
                      </p>
                      {enrollment.status === 'paused' ? (
                        <Button
                          type="button"
                          secondary
                          disabled={resume.isPending}
                          onClick={() => {
                            resume.mutate(enrollment);
                          }}
                        >
                          Resume enrollment
                        </Button>
                      ) : (
                        <div className="academy-form-grid">
                          <Field label="Pause from">
                            <Input
                              type="date"
                              value={pauseFrom}
                              onChange={(event) => {
                                setPauseFrom(event.target.value);
                              }}
                            />
                          </Field>
                          <Field label="Pause through">
                            <Input
                              type="date"
                              value={pauseTo}
                              onChange={(event) => {
                                setPauseTo(event.target.value);
                              }}
                            />
                          </Field>
                          <Button
                            type="button"
                            secondary
                            disabled={pause.isPending || pauseFrom > pauseTo}
                            onClick={() => {
                              pause.mutate(enrollment);
                            }}
                          >
                            Request pause
                          </Button>
                          <Button
                            type="button"
                            secondary
                            disabled={withdraw.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Request withdrawal from ${enrollment.offeringName}? Billing will follow the organization’s notice and refund rules.`,
                                )
                              )
                                withdraw.mutate(enrollment);
                            }}
                          >
                            Request withdrawal
                          </Button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState title="No current enrollments">
                  Browse available classes to enroll a student.
                </EmptyState>
              )}
              <p>
                <a href={paymentLink}>View invoices and payments</a>
              </p>
              <h2>Waitlist offers</h2>
              {waitlist.isLoading ? (
                <p role="status">Loading waitlist…</p>
              ) : waitlist.error ? (
                <Banner tone="error">{waitlist.error.message}</Banner>
              ) : waitlist.data?.items.length ? (
                <div className="academy-card-list">
                  {waitlist.data.items.map((entry) => (
                    <article className="academy-inset" key={entry.id}>
                      <h3>
                        {offerings.data?.items.find(
                          (item) =>
                            item.classOfferingId === entry.classOfferingId,
                        )?.name ?? 'Class offer'}
                      </h3>
                      <p>
                        {entry.personName} ·{' '}
                        {entry.status === 'offered'
                          ? `Offer expires ${entry.offerExpiresAt ?? 'soon'}`
                          : `Waitlist position ${String(entry.position)}`}
                      </p>
                      {entry.status === 'offered' && (
                        <div className="academy-actions">
                          <Button
                            type="button"
                            disabled={acceptWaitlist.isPending}
                            onClick={() => {
                              acceptWaitlist.mutate(entry);
                            }}
                          >
                            Accept offer
                          </Button>
                          <Button
                            type="button"
                            secondary
                            disabled={declineWaitlist.isPending}
                            onClick={() => {
                              declineWaitlist.mutate(entry.id);
                            }}
                          >
                            Decline offer
                          </Button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p>You have no active waitlist entries.</p>
              )}
            </Card>
          )}
          {tab === 'Make-up and bookings' && (
            <div className="academy-two-col">
              <Card>
                <h2>Make-up credits</h2>
                {credits.isLoading ? (
                  <p role="status">Loading make-up credits…</p>
                ) : credits.error ? (
                  <Banner tone="error">{credits.error.message}</Banner>
                ) : availableCredits.length ? (
                  <>
                    <Field label="Available credit">
                      <Select
                        value={creditId}
                        onChange={(event) => {
                          setCreditId(event.target.value);
                          setSessionId('');
                        }}
                      >
                        <option value="">Choose a credit</option>
                        {availableCredits.map((credit) => (
                          <option key={credit.id} value={credit.id}>
                            {credit.offeringName} · expires {credit.expiresOn}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {selectedCredit && (
                      <Field label="Eligible upcoming session">
                        <Select
                          value={sessionId}
                          onChange={(event) => {
                            setSessionId(event.target.value);
                          }}
                        >
                          <option value="">Choose a class session</option>
                          {(sessions.data?.items ?? [])
                            .filter(
                              (item) =>
                                item.spotsRemaining > 0 &&
                                item.status === 'scheduled',
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {new Date(item.startsAt).toLocaleString()} ·{' '}
                                {item.spotsRemaining} spots
                              </option>
                            ))}
                        </Select>
                      </Field>
                    )}
                    {selectedCredit &&
                      !sessions.isLoading &&
                      !(sessions.data?.items ?? []).some(
                        (item) =>
                          item.spotsRemaining > 0 &&
                          item.status === 'scheduled',
                      ) && (
                        <p>
                          No eligible session has an open spot in the next 60
                          days.
                        </p>
                      )}
                    <Button
                      type="button"
                      disabled={!creditId || !sessionId || bookMakeup.isPending}
                      onClick={() => {
                        bookMakeup.mutate();
                      }}
                    >
                      {bookMakeup.isPending ? 'Booking…' : 'Book make-up class'}
                    </Button>
                  </>
                ) : (
                  <EmptyState title="No available make-up credits">
                    Credits appear here when class attendance is recorded as
                    absent under the organization’s policy.
                  </EmptyState>
                )}
              </Card>
              <Card>
                <h2>Drop-in and punch card sessions</h2>
                <Field label="Class offering">
                  <Select
                    value={bookingOfferingId}
                    onChange={(event) => {
                      setBookingOfferingId(event.target.value);
                      setBookingSessionId('');
                    }}
                  >
                    <option value="">Choose a class</option>
                    {(offerings.data?.items ?? [])
                      .filter(
                        (offering) =>
                          offering.billing === 'drop_in' ||
                          offering.billing === 'punch_card',
                      )
                      .map((offering) => (
                        <option
                          key={offering.classOfferingId}
                          value={offering.classOfferingId}
                        >
                          {offering.name} · {offering.billing.replace('_', ' ')}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Class session">
                  <Select
                    value={bookingSessionId}
                    onChange={(event) => {
                      setBookingSessionId(event.target.value);
                    }}
                  >
                    <option value="">Choose an upcoming session</option>
                    {(bookingSessions.data?.items ?? [])
                      .filter(
                        (item) =>
                          item.spotsRemaining > 0 &&
                          item.status === 'scheduled',
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {new Date(item.startsAt).toLocaleString()} ·{' '}
                          {item.offeringName} · {item.spotsRemaining} spots
                        </option>
                      ))}
                  </Select>
                </Field>
                {bookingOfferingId && (
                  <p>
                    Showing open sessions for the selected drop-in class.{' '}
                    <Button
                      type="button"
                      secondary
                      onClick={() => {
                        setBookingOfferingId('');
                      }}
                    >
                      Clear class
                    </Button>
                  </p>
                )}
                <Button
                  type="button"
                  disabled={!bookingSessionId || bookDropIn.isPending}
                  onClick={() => {
                    bookDropIn.mutate();
                  }}
                >
                  {bookDropIn.isPending ? 'Booking…' : 'Book drop-in session'}
                </Button>
                <Field label="Punch card">
                  <Select
                    value={punchCardId}
                    onChange={(event) => {
                      setPunchCardId(event.target.value);
                    }}
                  >
                    <option value="">Choose a punch card</option>
                    {(punchCards.data?.items ?? [])
                      .filter(
                        (card) =>
                          card.status === 'active' && card.remainingUses > 0,
                      )
                      .map((card) => (
                        <option key={card.id} value={card.id}>
                          {card.offeringName} · {card.remainingUses} uses left
                        </option>
                      ))}
                  </Select>
                </Field>
                <Button
                  type="button"
                  secondary
                  disabled={
                    !punchCardId || !bookingSessionId || bookPunchCard.isPending
                  }
                  onClick={() => {
                    bookPunchCard.mutate();
                  }}
                >
                  {bookPunchCard.isPending ? 'Booking…' : 'Use punch card'}
                </Button>
                <p>
                  <a href={paymentLink}>Pay drop-in and punch card invoices</a>
                </p>
              </Card>
            </div>
          )}
          {tab === 'Skills and promotions' && (
            <div className="academy-two-col">
              <Card>
                <h2>Skill progress</h2>
                {progress.isLoading ? (
                  <p role="status">Loading progress…</p>
                ) : progress.error ? (
                  <Banner tone="error">{progress.error.message}</Banner>
                ) : progress.data?.levels.length ? (
                  progress.data.levels.map((level) => (
                    <section className="academy-inset" key={level.levelId}>
                      <h3>
                        {level.levelName} · {level.achievedCount}/
                        {level.totalCount} skills
                      </h3>
                      <ul>
                        {level.skills.map((skill) => (
                          <li key={skill.skillId}>
                            {skill.name} — {skill.status.replace('_', ' ')}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                ) : (
                  <EmptyState title="No skill records yet">
                    Coaches will share progress after adding class skills and
                    assessments.
                  </EmptyState>
                )}
              </Card>
              <Card>
                <h2>Promotion recommendations</h2>
                {promotions.isLoading ? (
                  <p role="status">Loading recommendations…</p>
                ) : promotions.error ? (
                  <Banner tone="error">{promotions.error.message}</Banner>
                ) : promotions.data?.items.filter(
                    (item) =>
                      item.status === 'recommended' ||
                      item.status === 'approved',
                  ).length ? (
                  promotions.data.items
                    .filter(
                      (item) =>
                        item.status === 'recommended' ||
                        item.status === 'approved',
                    )
                    .map((promotion) => {
                      const targetOptions =
                        offerings.data?.items.filter(
                          (item) => item.levelName === promotion.toLevelName,
                        ) ?? [];
                      const targetId =
                        promotionTargets[promotion.id] ||
                        promotion.targetClassOfferingId;
                      return (
                        <article className="academy-inset" key={promotion.id}>
                          <h3>
                            {promotion.personName} · {promotion.toLevelName}
                          </h3>
                          <p>
                            {promotion.note ??
                              'Your coach recommends this next level.'}
                          </p>
                          {!promotion.targetClassOfferingId && (
                            <Field label="Next class">
                              <Select
                                value={promotionTargets[promotion.id] ?? ''}
                                onChange={(event) => {
                                  setPromotionTargets((current) => ({
                                    ...current,
                                    [promotion.id]: event.target.value,
                                  }));
                                }}
                              >
                                <option value="">Choose a class</option>
                                {targetOptions.map((item) => (
                                  <option
                                    key={item.classOfferingId}
                                    value={item.classOfferingId}
                                  >
                                    {item.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                          )}
                          <div className="academy-actions">
                            <Button
                              type="button"
                              disabled={decidePromotion.isPending || !targetId}
                              onClick={() => {
                                decidePromotion.mutate({
                                  id: promotion.id,
                                  version: promotion.version,
                                  offeringId: targetId,
                                  decline: false,
                                });
                              }}
                            >
                              Accept recommendation and move class
                            </Button>
                            <Button
                              type="button"
                              secondary
                              disabled={decidePromotion.isPending}
                              onClick={() => {
                                decidePromotion.mutate({
                                  id: promotion.id,
                                  version: promotion.version,
                                  offeringId: null,
                                  decline: true,
                                });
                              }}
                            >
                              Decline
                            </Button>
                          </div>
                        </article>
                      );
                    })
                ) : (
                  <EmptyState title="No promotion decisions needed">
                    New recommendations from coaches will appear here.
                  </EmptyState>
                )}
                {promotions.data?.items.some(
                  (item) => item.status === 'completed',
                ) && (
                  <section>
                    <h3>Certificates</h3>
                    <ul>
                      {promotions.data.items
                        .filter((item) => item.status === 'completed')
                        .map((promotion) => (
                          <li key={promotion.id}>
                            {promotion.toLevelName}{' '}
                            <Button
                              type="button"
                              secondary
                              onClick={() =>
                                void downloadCertificate(promotion.id)
                              }
                            >
                              Download certificate
                            </Button>
                          </li>
                        ))}
                    </ul>
                  </section>
                )}
              </Card>
            </div>
          )}
          {tab === 'Tuition' && (
            <Card>
              <h2>Tuition subscriptions</h2>
              {subscriptions.isLoading ? (
                <p role="status">Loading subscriptions…</p>
              ) : subscriptions.error ? (
                <Banner tone="error">{subscriptions.error.message}</Banner>
              ) : subscriptions.data?.items.length ? (
                <div className="academy-card-list">
                  {subscriptions.data.items.map((subscription) => (
                    <article className="academy-inset" key={subscription.id}>
                      <h3>{subscription.householdName}</h3>
                      <p>
                        <Badge
                          tone={
                            subscription.status === 'active'
                              ? 'confirmed'
                              : 'neutral'
                          }
                        >
                          {subscription.status}
                        </Badge>{' '}
                        · {subscription.activeEnrollments} active enrollments ·
                        next bill {subscription.nextBillOn}
                      </p>
                      <Field label="Payment method">
                        <Select
                          value={paymentMethodId}
                          onChange={(event) => {
                            setPaymentMethodId(event.target.value);
                          }}
                        >
                          <option value="">Choose a saved method</option>
                          {(methods.data?.methods ?? []).map((method) => (
                            <option key={method.id} value={method.id}>
                              {methodName(method)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <label className="academy-check">
                        <input
                          type="checkbox"
                          checked={autopay}
                          onChange={(event) => {
                            setAutopay(event.target.checked);
                          }}
                        />
                        <span>
                          I authorize future tuition charges to the selected
                          saved method.
                        </span>
                      </label>
                      {subscription.paymentMethodId &&
                        paymentMethodId &&
                        subscription.paymentMethodId !== paymentMethodId &&
                        !autopay && (
                          <p>
                            Confirm autopay consent to replace the method on an
                            existing authorization.
                          </p>
                        )}
                      <Button
                        type="button"
                        disabled={
                          updateSubscription.isPending ||
                          !paymentMethodId ||
                          Boolean(
                            subscription.paymentMethodId &&
                            subscription.paymentMethodId !== paymentMethodId &&
                            !autopay,
                          )
                        }
                        onClick={() => {
                          updateSubscription.mutate({
                            subscription,
                            stopAutopay: false,
                          });
                        }}
                      >
                        Save payment settings
                      </Button>
                      {subscription.paymentMethodId && (
                        <Button
                          type="button"
                          secondary
                          disabled={updateSubscription.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                'Stop future automatic tuition charges for this subscription?',
                              )
                            )
                              updateSubscription.mutate({
                                subscription,
                                stopAutopay: true,
                              });
                          }}
                        >
                          Stop autopay
                        </Button>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState title="No tuition subscription yet">
                  A subscription is created when a student enrolls in a monthly
                  tuition class.
                </EmptyState>
              )}
              <p>
                <a href={paymentLink}>View invoices and payment history</a>
              </p>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
