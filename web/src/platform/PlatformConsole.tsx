import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { platformApi } from './api';
import { clearImpersonation, currentImpersonationId } from './impersonation';
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
type Impersonation = {
  id: string;
  organizationId: string;
  reason: string;
  readOnly: true;
  expiresAt: string;
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
          setError(cause instanceof Error ? cause.message : 'Request failed.');
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

export function ImpersonationBanner(): React.JSX.Element | null {
  const [current, setCurrent] = useState<Impersonation | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () => {
      const id = currentImpersonationId();
      if (!id) {
        setCurrent(null);
        return;
      }
      void platformApi<Impersonation>(
        `/impersonations/${encodeURIComponent(id)}`,
      )
        .then((result) => {
          if (live) setCurrent(result);
        })
        .catch(() => {
          clearImpersonation();
          if (live) setCurrent(null);
        });
    };
    refresh();
    window.addEventListener('athlentry:impersonation', refresh);
    return () => {
      live = false;
      window.removeEventListener('athlentry:impersonation', refresh);
    };
  }, []);
  useEffect(() => {
    if (!current) return;
    const remaining = new Date(current.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(
      () => {
        clearImpersonation();
        setCurrent(null);
      },
      Math.max(0, remaining),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [current]);
  if (!current) return null;
  return (
    <aside className="platform-console__impersonation" role="status">
      Read-only impersonation for organization {current.organizationId} expires
      at{' '}
      <time dateTime={current.expiresAt}>
        {new Date(current.expiresAt).toLocaleString()}
      </time>
      .
      <Link to={`/orgs/${current.organizationId}/credentials`}>
        Review safety requirements
      </Link>
      <button
        type="button"
        onClick={() => {
          void platformApi(`/impersonations/${current.id}`, {
            method: 'DELETE',
          })
            .then(() => {
              clearImpersonation();
              setCurrent(null);
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error ? cause.message : 'Request failed.',
              );
            });
        }}
      >
        End impersonation
      </button>
      {error && <span role="alert">{error}</span>}
    </aside>
  );
}

function OrganizationsPanel({ role }: { role: Role }): React.JSX.Element {
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
      setMessage('Organization status updated.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Request failed.');
    }
  }

  return (
    <section>
      <h2>Organizations</h2>
      <form
        className="platform-console__row"
        onSubmit={(event) => {
          event.preventDefault();
          setCursor(null);
          setSearch(searchInput.trim());
        }}
      >
        <label htmlFor="platform-org-search">Search</label>
        <input
          id="platform-org-search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.target.value);
          }}
          maxLength={100}
        />
        <button type="submit">Search</button>
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
                  {item.slug} · {item.status} · {item.planName ?? 'No plan'}
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
              First page
            </button>
          )}
          {page.data.nextCursor && (
            <button
              type="button"
              onClick={() => {
                setCursor(page.data?.nextCursor ?? null);
              }}
            >
              Next page
            </button>
          )}
        </>
      ) : (
        <p role="status">Loading organizations…</p>
      )}
      {org && (
        <div className="platform-console__card">
          <h3>{org.name}</h3>
          <dl>
            <dt>Status</dt>
            <dd>{org.status}</dd>
            <dt>Plan</dt>
            <dd>{org.planName ?? 'None'}</dd>
            <dt>Application fee</dt>
            <dd>
              {org.applicationFeeBps} basis points +{' '}
              {org.applicationFeeFixedCents} cents
            </dd>
            <dt>Stripe</dt>
            <dd>{org.stripe?.onboardingStatus ?? 'Not connected'}</dd>
            <dt>Charges</dt>
            <dd>{org.stripe?.chargesEnabled ? 'Enabled' : 'Disabled'}</dd>
            <dt>Payouts</dt>
            <dd>{org.stripe?.payoutsEnabled ? 'Enabled' : 'Disabled'}</dd>
          </dl>
          {role === 'super_admin' && (
            <div className="platform-console__row">
              {org.status === 'active' && (
                <button
                  type="button"
                  onClick={() => void changeStatus('suspended')}
                >
                  Suspend
                </button>
              )}
              {org.status === 'suspended' && (
                <button
                  type="button"
                  onClick={() => void changeStatus('active')}
                >
                  Reactivate
                </button>
              )}
              <label htmlFor="platform-org-plan">Plan</label>
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
                      setMessage('Plan updated.');
                    })
                    .catch((cause: unknown) => {
                      setMessage(
                        cause instanceof Error
                          ? cause.message
                          : 'Request failed.',
                      );
                    });
                }}
              >
                <option value="">Choose a plan</option>
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
                      `Read-only impersonation started until ${new Date(result.expiresAt).toLocaleString()}.`,
                    );
                    setReason('');
                  })
                  .catch((cause: unknown) => {
                    setMessage(
                      cause instanceof Error
                        ? cause.message
                        : 'Request failed.',
                    );
                  });
              }}
            >
              <label htmlFor="platform-impersonation-reason">
                Reason for read-only impersonation
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
              <button type="submit">Start read-only impersonation</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function PlansPanel(): React.JSX.Element {
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
      <h2>Plans</h2>
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
          New plan
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
                setMessage('Plan saved.');
              })
              .catch((cause: unknown) => {
                setMessage(
                  cause instanceof Error ? cause.message : 'Request failed.',
                );
              });
          } catch {
            setMessage('Limits must be valid JSON.');
          }
        }}
      >
        <label>
          Key
          <input
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
            }}
            required
          />
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
          />
        </label>
        <label>
          Monthly price (cents)
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
          Application fee (basis points)
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
          Fixed application fee (cents)
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
          Limits (JSON)
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
          Active
        </label>
        <button type="submit">Save plan</button>
      </form>
    </section>
  );
}

function FlagsPanel(): React.JSX.Element {
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
      <h2>Feature flags</h2>
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
          New flag
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
                setMessage('Feature flag saved.');
              })
              .catch((cause: unknown) => {
                setMessage(
                  cause instanceof Error ? cause.message : 'Request failed.',
                );
              });
          } catch {
            setMessage('Organization overrides must be valid JSON.');
          }
        }}
      >
        <label>
          Key
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
          Description
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
          Enabled by default
        </label>
        <label>
          Organization overrides (JSON)
          <textarea
            value={overrides}
            onChange={(event) => {
              setOverrides(event.target.value);
            }}
          />
        </label>
        <button type="submit">Save feature flag</button>
      </form>
    </section>
  );
}

function StaffPanel(): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const result = useLoad<{ items: Staff[] }>('/staff', revision);
  const [accountId, setAccountId] = useState('');
  const [role, setRole] = useState<Role>('support');
  const [active, setActive] = useState(true);
  const [message, setMessage] = useState('');
  return (
    <section>
      <h2>Platform staff</h2>
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
              {person.email} · {person.role} ·{' '}
              {person.active ? 'Active' : 'Inactive'}
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
              setMessage('Staff access saved.');
            })
            .catch((cause: unknown) => {
              setMessage(
                cause instanceof Error ? cause.message : 'Request failed.',
              );
            });
        }}
      >
        <label>
          Existing account ID
          <input
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
            }}
            required
          />
        </label>
        <label>
          Role
          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value as Role);
            }}
          >
            <option value="support">Support</option>
            <option value="finance_ops">Finance operations</option>
            <option value="super_admin">Super admin</option>
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
          Active
        </label>
        <button type="submit">Save staff access</button>
      </form>
    </section>
  );
}

function HealthPanel(): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const result = useLoad<Health>('/health', revision);
  return (
    <section>
      <h2>System health</h2>
      <button
        type="button"
        onClick={() => {
          setRevision((value) => value + 1);
        }}
      >
        Refresh health
      </button>
      <Message text={result.error} />
      {result.data && (
        <>
          <dl>
            <dt>Worker heartbeat</dt>
            <dd>{result.data.workerHeartbeatAt ?? 'No active worker'}</dd>
            <dt>Last Stripe webhook received</dt>
            <dd>{result.data.lastStripeWebhookReceivedAt ?? 'None'}</dd>
            <dt>Last Stripe webhook processed</dt>
            <dd>{result.data.lastStripeWebhookProcessedAt ?? 'None'}</dd>
          </dl>
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>Pending</th>
                <th>Failed</th>
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
              <h3>Failed jobs</h3>
              <table>
                <thead>
                  <tr>
                    <th>Queue</th>
                    <th>Job ID</th>
                    <th>Created</th>
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
  const role = useLoad<StaffMe>('/me', 0);
  const [tab, setTab] = useState<
    'orgs' | 'plans' | 'flags' | 'staff' | 'health'
  >('orgs');
  const staffRole = role.data?.role;
  return (
    <main className="platform-console">
      <header>
        <h1>Platform</h1>
        <p>Organization operations and system health</p>
      </header>
      <Message text={role.error} />
      {staffRole ? (
        <>
          <nav
            aria-label="Platform sections"
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
                    ? 'Organizations'
                    : item === 'flags'
                      ? 'Feature flags'
                      : item === 'staff'
                        ? 'Staff'
                        : item === 'health'
                          ? 'Health'
                          : 'Plans'}
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
        !role.error && <p role="status">Loading platform access…</p>
      )}
    </main>
  );
}
