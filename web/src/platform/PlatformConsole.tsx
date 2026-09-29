import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n } from '../lib/i18n';

import type { Impersonation } from './ImpersonationBanner';
import { platformApi } from './api';
import './platform.css';

type Role = 'super_admin' | 'support' | 'finance_ops';
type StaffMe = { accountId: string; role: Role };
type Org = {
  id: string;
  slug: string;
  name: string;
  status: string;
  planName: string | null;
  version: number;
};
type OrgPage = { items: Org[]; nextCursor: string | null };
type OrgDetail = Org & {
  planId: string | null;
  applicationFeeBps: number;
  applicationFeeFixedCents: number;
  stripe: {
    onboardingStatus: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  } | null;
};
type Plan = {
  id: string;
  key: string;
  name: string;
  monthlyPriceCents: number;
  applicationFeeBps: number;
  applicationFeeFixedCents: number;
  limits: Record<string, number>;
  active: boolean;
  version: number;
};
type Flag = {
  key: string;
  description: string;
  enabled: boolean;
  organizationOverrides: Record<string, boolean>;
  version: number;
};
type Staff = {
  accountId: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
};
type Health = {
  queues: { name: string; pending: number; failed: number }[];
  failedJobs: { id: string; queue: string; createdAt: string }[];
  workerHeartbeatAt: string | null;
  lastStripeWebhookReceivedAt: string | null;
  lastStripeWebhookProcessedAt: string | null;
};
function useLoad<T>(
  path: string,
  revision: number,
  initial: T | null = null,
): { data: T | null; error: string } {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setData(null);
    void platformApi<T>(path)
      .then((value) => {
        if (live) {
          setData(value);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (live)
          setError(
            cause instanceof Error
              ? cause.message
              : i18n.t('requestFailed', { ns: 'platform' }),
          );
      });
    return () => {
      live = false;
    };
  }, [path, revision]);
  return { data, error };
}

function Message({ text }: { text: string }): React.JSX.Element | null {
  return text ? (
    <p role="alert" className="platform-console__error">
      {text}
    </p>
  ) : null;
}

function OrganizationsPanel({ role }: { role: Role }): React.JSX.Element {
  const { t } = useTranslation('platform');
  const statusLabel = (value: string) =>
    t(`statuses.${value}`, { defaultValue: value });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const query = new URLSearchParams({ limit: '50' });
  if (search) query.set('search', search);
  if (cursor) query.set('cursor', cursor);
  const page = useLoad<OrgPage>(`/orgs?${query}`, revision);
  const detail = useLoad<OrgDetail>(
    selected ? `/orgs/${selected}` : '/me',
    revision,
  );
  const plans = useLoad<{ items: Plan[] }>('/plans', revision);
  const org = selected && detail.data?.id === selected ? detail.data : null;

  async function changeStatus(status: 'active' | 'suspended') {
    if (!org) return;
    try {
      await platformApi(`/orgs/${org.id}/status`, {
        method: 'PATCH',
        body: { status, expectedVersion: org.version },
      });
      setRevision((value) => value + 1);
      setMessage(t('organizationStatusUpdated'));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('requestFailed'));
    }
  }

  return (
    <section>
      <h2>{t('organizations')}</h2>
      <form
        className="platform-console__row"
        onSubmit={(event) => {
          event.preventDefault();
          setCursor(null);
          setSearch(searchInput.trim());
        }}
      >
        <label htmlFor="platform-org-search">{t('search')}</label>
        <input
          id="platform-org-search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.target.value);
          }}
          maxLength={100}
        />
        <button type="submit">{t('search')}</button>
      </form>
      <Message text={page.error || detail.error || message} />
      {page.data ? (
        <>
          <ul className="platform-console__list">
            {page.data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(item.id);
                  }}
                >
                  {item.name}
                </button>
                <span>
                  {item.slug} · {statusLabel(item.status)} ·{' '}
                  {item.planName ?? t('noPlan')}
                </span>
              </li>
            ))}
          </ul>
          {cursor && (
            <button
              type="button"
              onClick={() => {
                setCursor(null);
              }}
            >
              {t('firstPage')}
            </button>
          )}
          {page.data.nextCursor && (
            <button
              type="button"
              onClick={() => {
                setCursor(page.data?.nextCursor ?? null);
              }}
            >
              {t('nextPage')}
            </button>
          )}
        </>
      ) : (
        <p role="status">{t('loadingOrganizations')}</p>
      )}
      {org && (
        <div className="platform-console__card">
          <h3>{org.name}</h3>
          <dl>
            <dt>{t('status')}</dt>
            <dd>{statusLabel(org.status)}</dd>
            <dt>{t('plan')}</dt>
            <dd>{org.planName ?? t('none')}</dd>
            <dt>{t('applicationFee')}</dt>
            <dd>
              {t('applicationFeeFormat', {
                bps: org.applicationFeeBps,
                cents: org.applicationFeeFixedCents,
              })}
            </dd>
            <dt>{t('stripe')}</dt>
            <dd>
              {org.stripe
                ? statusLabel(org.stripe.onboardingStatus)
                : t('notConnected')}
            </dd>
            <dt>{t('charges')}</dt>
            <dd>{org.stripe?.chargesEnabled ? t('enabled') : t('disabled')}</dd>
            <dt>{t('payouts')}</dt>
            <dd>{org.stripe?.payoutsEnabled ? t('enabled') : t('disabled')}</dd>
          </dl>
          {role === 'super_admin' && (
            <div className="platform-console__row">
              {org.status === 'active' && (
                <button
                  type="button"
                  onClick={() => void changeStatus('suspended')}
                >
                  {t('suspend')}
                </button>
              )}
              {org.status === 'suspended' && (
                <button
                  type="button"
                  onClick={() => void changeStatus('active')}
                >
                  {t('reactivate')}
                </button>
              )}
              <label htmlFor="platform-org-plan">{t('plan')}</label>
              <select
                id="platform-org-plan"
                value={org.planId ?? ''}
                onChange={(event) => {
                  const planId = event.target.value;
                  if (!planId) return;
                  void platformApi(`/orgs/${org.id}/plan`, {
                    method: 'PATCH',
                    body: { planId, expectedVersion: org.version },
                  })
                    .then(() => {
                      setRevision((value) => value + 1);
                      setMessage(t('planUpdated'));
                    })
                    .catch((cause: unknown) => {
                      setMessage(
                        cause instanceof Error
                          ? cause.message
                          : t('requestFailed'),
                      );
                    });
                }}
              >
                <option value="">{t('choosePlan')}</option>
                {plans.data?.items
                  .filter((plan) => plan.active)
                  .map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {role !== 'finance_ops' && (
            <form
              className="platform-console__row"
              onSubmit={(event) => {
                event.preventDefault();
                void platformApi<Impersonation>('/impersonations', {
                  method: 'POST',
                  body: { organizationId: org.id, reason },
                })
                  .then((result) => {
                    sessionStorage.setItem(
                      'athlentry.impersonation',
                      result.id,
                    );
                    window.dispatchEvent(new Event('athlentry:impersonation'));
                    setMessage(
                      t('impersonationStarted', {
                        expiresAt: new Date(result.expiresAt).toLocaleString(),
                      }),
                    );
                    setReason('');
                  })
                  .catch((cause: unknown) => {
                    setMessage(
                      cause instanceof Error
                        ? cause.message
                        : t('requestFailed'),
                    );
                  });
              }}
            >
              <label htmlFor="platform-impersonation-reason">
                {t('impersonationReason')}
              </label>
              <input
                id="platform-impersonation-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                minLength={10}
                maxLength={500}
                required
              />
              <button type="submit">{t('startReadOnlyImpersonation')}</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function PlansPanel(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const [revision, setRevision] = useState(0);
  const result = useLoad<{ items: Plan[] }>('/plans', revision);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [monthly, setMonthly] = useState('0');
  const [bps, setBps] = useState('0');
  const [fixed, setFixed] = useState('0');
  const [limits, setLimits] = useState('{}');
  const [active, setActive] = useState(true);
  const [message, setMessage] = useState('');
  return (
    <section>
      <h2>{t('plans')}</h2>
      <Message text={result.error || message} />
      <div className="platform-console__row">
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setKey('');
            setName('');
            setMonthly('0');
            setBps('0');
            setFixed('0');
            setLimits('{}');
            setActive(true);
          }}
        >
          {t('newPlan')}
        </button>
        {result.data?.items.map((plan) => (
          <button
            key={plan.id}
            type="button"
            onClick={() => {
              setSelected(plan);
              setKey(plan.key);
              setName(plan.name);
              setMonthly(String(plan.monthlyPriceCents));
              setBps(String(plan.applicationFeeBps));
              setFixed(String(plan.applicationFeeFixedCents));
              setLimits(JSON.stringify(plan.limits));
              setActive(plan.active);
            }}
          >
            {plan.name}
          </button>
        ))}
      </div>
      <form
        className="platform-console__form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const body = {
              key,
              name,
              monthlyPriceCents: Number(monthly),
              applicationFeeBps: Number(bps),
              applicationFeeFixedCents: Number(fixed),
              limits: JSON.parse(limits) as unknown,
              active,
              expectedVersion: selected?.version ?? 0,
            };
            void platformApi(selected ? `/plans/${selected.id}` : '/plans', {
              method: selected ? 'PUT' : 'POST',
              body,
            })
              .then(() => {
                setRevision((value) => value + 1);
                setMessage(t('planSaved'));
              })
              .catch((cause: unknown) => {
                setMessage(
                  cause instanceof Error ? cause.message : t('requestFailed'),
                );
              });
          } catch {
            setMessage(t('limitsMustBeJson'));
          }
        }}
      >
        <label>
          {t('key')}
          <input
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
            }}
            required
          />
        </label>
        <label>
          {t('name')}
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
          />
        </label>
        <label>
          {t('monthlyPriceCents')}
          <input
            type="number"
            min="0"
            step="1"
            value={monthly}
            onChange={(event) => {
              setMonthly(event.target.value);
            }}
            required
          />
        </label>
        <label>
          {t('applicationFeeBps')}
          <input
            type="number"
            min="0"
            max="10000"
            step="1"
            value={bps}
            onChange={(event) => {
              setBps(event.target.value);
            }}
            required
          />
        </label>
        <label>
          {t('fixedApplicationFeeCents')}
          <input
            type="number"
            min="0"
            step="1"
            value={fixed}
            onChange={(event) => {
              setFixed(event.target.value);
            }}
            required
          />
        </label>
        <label>
          {t('limitsJson')}
          <textarea
            value={limits}
            onChange={(event) => {
              setLimits(event.target.value);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
            }}
          />{' '}
          {t('active')}
        </label>
        <button type="submit">{t('savePlan')}</button>
      </form>
    </section>
  );
}

function FlagsPanel(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const [revision, setRevision] = useState(0);
  const result = useLoad<{ items: Flag[] }>('/feature-flags', revision);
  const [selected, setSelected] = useState<Flag | null>(null);
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [overrides, setOverrides] = useState('{}');
  const [message, setMessage] = useState('');
  return (
    <section>
      <h2>{t('featureFlags')}</h2>
      <Message text={result.error || message} />
      <div className="platform-console__row">
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setKey('');
            setDescription('');
            setEnabled(false);
            setOverrides('{}');
          }}
        >
          {t('newFlag')}
        </button>
        {result.data?.items.map((flag) => (
          <button
            type="button"
            key={flag.key}
            onClick={() => {
              setSelected(flag);
              setKey(flag.key);
              setDescription(flag.description);
              setEnabled(flag.enabled);
              setOverrides(JSON.stringify(flag.organizationOverrides));
            }}
          >
            {flag.key}
          </button>
        ))}
      </div>
      <form
        className="platform-console__form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            void platformApi(`/feature-flags/${encodeURIComponent(key)}`, {
              method: 'PUT',
              body: {
                description,
                enabled,
                organizationOverrides: JSON.parse(overrides) as unknown,
                expectedVersion: selected?.version ?? 0,
              },
            })
              .then(() => {
                setRevision((value) => value + 1);
                setMessage(t('featureFlagSaved'));
              })
              .catch((cause: unknown) => {
                setMessage(
                  cause instanceof Error ? cause.message : t('requestFailed'),
                );
              });
          } catch {
            setMessage(t('overridesMustBeJson'));
          }
        }}
      >
        <label>
          {t('key')}
          <input
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
            }}
            readOnly={selected !== null}
            required
          />
        </label>
        <label>
          {t('description')}
          <input
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            required
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
            }}
          />{' '}
          {t('enabledByDefault')}
        </label>
        <label>
          {t('organizationOverridesJson')}
          <textarea
            value={overrides}
            onChange={(event) => {
              setOverrides(event.target.value);
            }}
          />
        </label>
        <button type="submit">{t('saveFeatureFlag')}</button>
      </form>
    </section>
  );
}

function StaffPanel(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const [revision, setRevision] = useState(0);
  const result = useLoad<{ items: Staff[] }>('/staff', revision);
  const [accountId, setAccountId] = useState('');
  const [role, setRole] = useState<Role>('support');
  const [active, setActive] = useState(true);
  const [message, setMessage] = useState('');
  return (
    <section>
      <h2>{t('platformStaff')}</h2>
      <Message text={result.error || message} />
      <ul className="platform-console__list">
        {result.data?.items.map((person) => (
          <li key={person.accountId}>
            <button
              type="button"
              onClick={() => {
                setAccountId(person.accountId);
                setRole(person.role);
                setActive(person.active);
              }}
            >
              {person.name}
            </button>
            <span>
              {person.email} · {t(`roles.${person.role}`)} ·{' '}
              {person.active ? t('active') : t('inactive')}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="platform-console__form"
        onSubmit={(event) => {
          event.preventDefault();
          void platformApi(`/staff/${encodeURIComponent(accountId)}`, {
            method: 'PUT',
            body: { role, active },
          })
            .then(() => {
              setRevision((value) => value + 1);
              setMessage(t('staffAccessSaved'));
            })
            .catch((cause: unknown) => {
              setMessage(
                cause instanceof Error ? cause.message : t('requestFailed'),
              );
            });
        }}
      >
        <label>
          {t('existingAccountId')}
          <input
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
            }}
            required
          />
        </label>
        <label>
          {t('role')}
          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value as Role);
            }}
          >
            <option value="support">{t('roles.support')}</option>
            <option value="finance_ops">{t('roles.finance_ops')}</option>
            <option value="super_admin">{t('roles.super_admin')}</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
            }}
          />{' '}
          {t('active')}
        </label>
        <button type="submit">{t('saveStaffAccess')}</button>
      </form>
    </section>
  );
}

function HealthPanel(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const [revision, setRevision] = useState(0);
  const result = useLoad<Health>('/health', revision);
  return (
    <section>
      <h2>{t('systemHealth')}</h2>
      <button
        type="button"
        onClick={() => {
          setRevision((value) => value + 1);
        }}
      >
        {t('refreshHealth')}
      </button>
      <Message text={result.error} />
      {result.data && (
        <>
          <dl>
            <dt>{t('workerHeartbeat')}</dt>
            <dd>{result.data.workerHeartbeatAt ?? t('noActiveWorker')}</dd>
            <dt>{t('lastStripeWebhookReceived')}</dt>
            <dd>{result.data.lastStripeWebhookReceivedAt ?? t('none')}</dd>
            <dt>{t('lastStripeWebhookProcessed')}</dt>
            <dd>{result.data.lastStripeWebhookProcessedAt ?? t('none')}</dd>
          </dl>
          <table>
            <thead>
              <tr>
                <th>{t('queue')}</th>
                <th>{t('pending')}</th>
                <th>{t('failed')}</th>
              </tr>
            </thead>
            <tbody>
              {result.data.queues.map((queue) => (
                <tr key={queue.name}>
                  <td>{queue.name}</td>
                  <td>{queue.pending}</td>
                  <td>{queue.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.data.failedJobs.length > 0 && (
            <>
              <h3>{t('failedJobs')}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t('queue')}</th>
                    <th>{t('jobId')}</th>
                    <th>{t('created')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.failedJobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.queue}</td>
                      <td>{job.id}</td>
                      <td>{new Date(job.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function PlatformConsole(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const role = useLoad<StaffMe>('/me', 0);
  const [tab, setTab] = useState<
    'orgs' | 'plans' | 'flags' | 'staff' | 'health'
  >('orgs');
  const staffRole = role.data?.role;
  return (
    <main className="platform-console">
      <header>
        <h1>{t('platform')}</h1>
        <p>{t('organizationOperations')}</p>
      </header>
      <Message text={role.error} />
      {staffRole ? (
        <>
          <nav
            aria-label={t('platformSections')}
            className="platform-console__tabs"
          >
            {(['orgs', 'plans', 'flags', 'staff', 'health'] as const)
              .filter(
                (item) =>
                  staffRole === 'super_admin' ||
                  !['plans', 'flags', 'staff'].includes(item),
              )
              .map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-current={tab === item ? 'page' : undefined}
                  onClick={() => {
                    setTab(item);
                  }}
                >
                  {item === 'orgs'
                    ? t('organizations')
                    : item === 'flags'
                      ? t('featureFlags')
                      : item === 'staff'
                        ? t('staff')
                        : item === 'health'
                          ? t('health')
                          : t('plans')}
                </button>
              ))}
          </nav>
          {tab === 'orgs' && <OrganizationsPanel role={staffRole} />}
          {tab === 'plans' && staffRole === 'super_admin' && <PlansPanel />}
          {tab === 'flags' && staffRole === 'super_admin' && <FlagsPanel />}
          {tab === 'staff' && staffRole === 'super_admin' && <StaffPanel />}
          {tab === 'health' && <HealthPanel />}
        </>
      ) : (
        !role.error && <p role="status">{t('loadingPlatformAccess')}</p>
      )}
    </main>
  );
}
