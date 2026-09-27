import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  RichTextEditor,
  Select,
  Textarea,
} from '../../ui';

import type {
  AudienceOptions,
  Campaign,
  CampaignDetail,
  CampaignDraft,
  Channel,
  LocaleCopy,
  Preview,
  RegistrationStatus,
} from './api';
import { communicationsRequest } from './api';

import './messages.css';

const blankLocale = (): LocaleCopy => ({
  subject: '',
  bodyHtml: '',
  bodyText: '',
  smsText: '',
  pushText: '',
});
const blankDraft = (): CampaignDraft => ({
  channels: ['in_app', 'email'],
  category: 'announcement',
  audience: { include: {}, exclude: {}, filters: {} },
  subject: '',
  bodyHtml: '',
  bodyText: '',
  smsText: '',
  pushText: '',
  localeVariants: { en: blankLocale(), es: blankLocale() },
});
const channels: { id: Channel; label: string }[] = [
  { id: 'in_app', label: 'In-app' },
  { id: 'email', label: 'Email' },
  { id: 'sms', label: 'SMS' },
  { id: 'push', label: 'Push' },
];
const roleOptions = [
  { id: 'athletes_guardians', label: 'Athletes and guardians' },
  { id: 'coaches', label: 'Coaches and team staff' },
  { id: 'officials', label: 'Officials' },
  { id: 'volunteers', label: 'Volunteers' },
  { id: 'board', label: 'Owners and administrators' },
];
type ConsoleView = 'campaigns' | 'sender' | 'moderation' | 'chat';
type CampaignStats = {
  id: string;
  status: string;
  counts: Record<string, Record<string, number>>;
};

export function MessagesConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<CampaignDraft>(blankDraft);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Campaign['status'] | 'new'>('new');
  const [options, setOptions] = useState<AudienceOptions>({
    people: [],
    teams: [],
    programs: [],
  });
  const [search, setSearch] = useState('');
  const [locale, setLocale] = useState<'en' | 'es'>('en');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ConsoleView>('campaigns');
  const [stats, setStats] = useState<CampaignStats | null>(null);

  const base = `/orgs/${encodeURIComponent(orgId)}`;
  const reload = useCallback(async () => {
    try {
      const response = await communicationsRequest<{ items: Campaign[] }>(
        `${base}/campaigns`,
      );
      setCampaigns(response.items);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load campaigns.',
      );
    }
  }, [base]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void communicationsRequest<AudienceOptions>(
        `${base}/audience-options${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`,
      )
        .then((result) => {
          if (!cancelled) setOptions(result);
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not load audience options.',
            );
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, search]);

  const selectedSummary = useMemo(
    () => campaigns.find((item) => item.id === selectedId),
    [campaigns, selectedId],
  );
  const canEdit = status === 'new' || status === 'draft';
  const setAudience = (
    side: 'include' | 'exclude',
    key: 'personIds' | 'teamSeasonIds' | 'programIds' | 'roles',
    id: string,
    checked: boolean,
  ) => {
    setDraft((current) => {
      const previous = current.audience[side][key] ?? [];
      const values = checked
        ? [...new Set([...previous, id])]
        : previous.filter((item) => item !== id);
      return {
        ...current,
        audience: {
          ...current.audience,
          [side]: { ...current.audience[side], [key]: values },
        },
      };
    });
    setPreview(null);
  };
  const setAudienceFilter = (
    key: 'registrationStatuses' | 'pastDueBalance',
    value: string | boolean,
  ) => {
    setDraft((current) => ({
      ...current,
      audience: {
        ...current.audience,
        filters: {
          ...current.audience.filters,
          [key]:
            key === 'registrationStatuses'
              ? value
                ? [value as RegistrationStatus]
                : []
              : value,
        },
      },
    }));
    setPreview(null);
  };

  const openCampaign = async (id: string) => {
    setError('');
    setNotice('');
    setPreview(null);
    setBusy(true);
    try {
      const result = await communicationsRequest<CampaignDetail>(
        `${base}/campaigns/${encodeURIComponent(id)}`,
      );
      setSelectedId(result.id);
      setDraft(result.draft);
      setVersion(result.version);
      setStatus(result.status);
      setLocale('en');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not open campaign.',
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<{ id: string; version: number } | null> => {
    if (!canEdit && selectedId) return null;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (selectedId && (status === 'draft' || status === 'scheduled')) {
        const result = await communicationsRequest<Campaign>(
          `${base}/campaigns/${encodeURIComponent(selectedId)}`,
          'PUT',
          { draft, expectedVersion: version },
        );
        setVersion(result.version);
        setStatus(result.status);
        setNotice('Draft saved.');
        await reload();
        return { id: selectedId, version: result.version };
      }
      if (selectedId) return { id: selectedId, version };
      const result = await communicationsRequest<Campaign>(
        `${base}/campaigns`,
        'POST',
        draft,
      );
      setSelectedId(result.id);
      setVersion(result.version);
      setStatus(result.status);
      setNotice('Draft created.');
      await reload();
      return { id: result.id, version: result.version };
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save campaign.',
      );
      return null;
    } finally {
      setBusy(false);
    }
  };

  const getPreview = async (): Promise<Preview | null> => {
    const saved =
      selectedId && !canEdit ? { id: selectedId, version } : await save();
    if (!saved) return null;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await communicationsRequest<Preview>(
        `${base}/campaigns/${encodeURIComponent(saved.id)}/preview`,
        'POST',
        {},
      );
      setPreview(result);
      setNotice('Audience preview updated.');
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not preview audience.',
      );
      return null;
    } finally {
      setBusy(false);
    }
  };

  const testSend = async () => {
    const saved =
      selectedId && status === 'scheduled'
        ? { id: selectedId, version }
        : await save();
    if (!saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await communicationsRequest<{
        testedAt: string;
        results: { channel: string; status: string }[];
      }>(
        `${base}/campaigns/${encodeURIComponent(saved.id)}/test-send`,
        'POST',
        {},
      );
      setNotice(
        `Test sent to your account: ${result.results.map((item) => `${item.channel} ${item.status}`).join(', ')}.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send test.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    let audience: Preview;
    try {
      audience = await communicationsRequest<Preview>(
        `${base}/campaigns/${encodeURIComponent(saved.id)}/preview`,
        'POST',
        {},
      );
      setPreview(audience);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not preview audience.',
      );
      setBusy(false);
      return;
    }
    setBusy(false);
    const summary = Object.entries(audience.counts)
      .map(([channel, count]) => `${channel}: ${String(count)}`)
      .join('\n');
    if (
      !window.confirm(
        `Send this message to ${String(audience.recipientCount)} selected people?\n\nEligible destinations:\n${summary}`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await communicationsRequest(
        `${base}/campaigns/${encodeURIComponent(saved.id)}/send`,
        'POST',
        {
          expectedVersion: saved.version,
          confirmRecipientCounts: audience.counts,
          ...(draft.category === 'emergency' ? { confirmEmergency: true } : {}),
        },
      );
      setStatus('sending');
      setNotice('Campaign queued for delivery.');
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not send campaign.',
      );
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    if (!scheduleAt) {
      setError('Choose a future send time.');
      return;
    }
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await communicationsRequest<Campaign>(
        `${base}/campaigns/${encodeURIComponent(saved.id)}/schedule`,
        'POST',
        {
          scheduledFor: new Date(scheduleAt).toISOString(),
          expectedVersion: saved.version,
        },
      );
      setStatus(result.status);
      setVersion(result.version);
      setNotice('Campaign scheduled.');
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not schedule campaign.',
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!selectedId || !window.confirm('Cancel this scheduled campaign?'))
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await communicationsRequest<Campaign>(
        `${base}/campaigns/${encodeURIComponent(selectedId)}/cancel`,
        'POST',
        { expectedVersion: version },
      );
      setStatus(result.status);
      setVersion(result.version);
      setNotice('Campaign canceled.');
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not cancel campaign.',
      );
    } finally {
      setBusy(false);
    }
  };

  const loadStats = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      setStats(
        await communicationsRequest<CampaignStats>(
          `${base}/campaigns/${encodeURIComponent(selectedId)}/stats`,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load delivery statistics.',
      );
    } finally {
      setBusy(false);
    }
  };

  const editLocale = (key: keyof LocaleCopy, value: string) => {
    setDraft((current) => ({
      ...current,
      ...(locale === 'en'
        ? {
            subject: key === 'subject' ? value : current.subject,
            bodyHtml: key === 'bodyHtml' ? value : current.bodyHtml,
            bodyText: key === 'bodyText' ? value : current.bodyText,
            smsText: key === 'smsText' ? value : current.smsText,
          }
        : {}),
      localeVariants: {
        ...current.localeVariants,
        [locale]: { ...current.localeVariants[locale], [key]: value },
      },
    }));
    setPreview(null);
  };
  const copy = draft.localeVariants[locale];
  const campaign = selectedSummary;

  return (
    <main className="messages-console">
      <header className="messages-header">
        <div>
          <p className="messages-eyebrow">COMMUNICATIONS</p>
          <h1>Messages</h1>
          <p>Build, review and deliver organization updates.</p>
        </div>
        <div className="messages-header-actions">
          <Button
            disabled={busy}
            onClick={() => {
              setView('campaigns');
              setSelectedId('');
              setDraft(blankDraft());
              setVersion(0);
              setStatus('new');
              setPreview(null);
              setStats(null);
              setError('');
              setNotice('');
            }}
          >
            New campaign
          </Button>
          <Button
            secondary
            disabled={busy}
            onClick={() => {
              setView('campaigns');
              setSelectedId('');
              setDraft({
                ...blankDraft(),
                category: 'emergency',
                channels: ['in_app', 'email', 'sms', 'push'],
              });
              setVersion(0);
              setStatus('new');
              setPreview(null);
              setStats(null);
              setError('');
              setNotice('Emergency broadcast draft created.');
            }}
          >
            Emergency message
          </Button>
        </div>
      </header>
      {error && (
        <div role="alert" className="messages-alert messages-alert--error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="messages-alert">
          {notice}
        </div>
      )}
      <nav className="messages-console-tabs" aria-label="Communication tools">
        <Button
          type="button"
          secondary={view !== 'campaigns'}
          aria-current={view === 'campaigns' ? 'page' : undefined}
          onClick={() => {
            setView('campaigns');
          }}
        >
          Campaigns
        </Button>
        <Button
          type="button"
          secondary={view !== 'sender'}
          aria-current={view === 'sender' ? 'page' : undefined}
          onClick={() => {
            setView('sender');
          }}
        >
          Sender settings
        </Button>
        <Button
          type="button"
          secondary={view !== 'moderation'}
          aria-current={view === 'moderation' ? 'page' : undefined}
          onClick={() => {
            setView('moderation');
          }}
        >
          Chat moderation
        </Button>
        <Button
          type="button"
          secondary={view !== 'chat'}
          aria-current={view === 'chat' ? 'page' : undefined}
          onClick={() => {
            setView('chat');
          }}
        >
          Chat channels
        </Button>
      </nav>
      {view === 'sender' && <SenderIdentityPanel orgId={orgId} />}
      {view === 'moderation' && <ModerationPanel orgId={orgId} />}
      {view === 'chat' && <ChatChannelsPanel orgId={orgId} />}
      {view === 'campaigns' && (
        <div className="messages-layout">
          <Card className="messages-list-card">
            <h2>Campaigns</h2>
            {campaigns.length ? (
              <ul className="messages-campaign-list">
                {campaigns.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={selectedId === item.id ? 'is-current' : ''}
                      aria-current={selectedId === item.id ? 'page' : undefined}
                      onClick={() => void openCampaign(item.id)}
                    >
                      <span>{item.subject || 'Untitled message'}</span>
                      <small>
                        {item.category} · {item.status}
                      </small>
                      <small>{item.channels.join(', ')}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No campaigns yet. Start a draft to send your first update.</p>
            )}
          </Card>
          <section className="messages-editor" aria-label="Campaign editor">
            <Card>
              <div className="messages-editor-title">
                <div>
                  <p className="messages-eyebrow">
                    {status === 'new'
                      ? 'NEW DRAFT'
                      : `CAMPAIGN · ${status.toUpperCase()}`}
                  </p>
                  <h2>
                    {draft.subject || campaign?.subject || 'Campaign composer'}
                  </h2>
                </div>
                {selectedId && (
                  <span className="messages-version">v{version}</span>
                )}
              </div>
              <div className="messages-grid messages-grid--short">
                <Field label="Message category">
                  <Select
                    disabled={!canEdit}
                    value={draft.category}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        category: event.target
                          .value as CampaignDraft['category'],
                      }));
                      setPreview(null);
                    }}
                    options={[
                      { value: 'operational', label: 'Operational' },
                      { value: 'announcement', label: 'Announcement' },
                      { value: 'marketing', label: 'Marketing (opt-in only)' },
                      { value: 'emergency', label: 'Emergency broadcast' },
                    ]}
                  />
                </Field>
                <fieldset className="messages-channel-field">
                  <legend>Delivery channels</legend>
                  <div className="messages-check-row">
                    {channels.map((channel) => (
                      <label key={channel.id}>
                        <Checkbox
                          disabled={!canEdit}
                          checked={draft.channels.includes(channel.id)}
                          onChange={(event) => {
                            setDraft((current) => ({
                              ...current,
                              channels: event.target.checked
                                ? [...current.channels, channel.id]
                                : current.channels.filter(
                                    (value) => value !== channel.id,
                                  ),
                            }));
                          }}
                        />
                        {channel.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <section
                className="messages-audience"
                aria-labelledby="audience-heading"
              >
                <div className="messages-section-title">
                  <div>
                    <h3 id="audience-heading">Audience</h3>
                    <p>
                      Choose people, teams, programs or roles to include.
                      Filters narrow that audience, and exclusions always win.
                    </p>
                  </div>
                  <Field label="Search audience">
                    <Input
                      type="search"
                      disabled={!canEdit}
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                      }}
                      placeholder="Find a person, team or program"
                    />
                  </Field>
                </div>
                <div className="messages-audience-grid">
                  <SelectorGroup
                    disabled={!canEdit}
                    title="People"
                    items={options.people}
                    selected={draft.audience.include.personIds ?? []}
                    excluded={draft.audience.exclude.personIds ?? []}
                    include={(id, checked) => {
                      setAudience('include', 'personIds', id, checked);
                    }}
                    exclude={(id, checked) => {
                      setAudience('exclude', 'personIds', id, checked);
                    }}
                  />
                  <SelectorGroup
                    disabled={!canEdit}
                    title="Teams"
                    items={options.teams}
                    selected={draft.audience.include.teamSeasonIds ?? []}
                    excluded={draft.audience.exclude.teamSeasonIds ?? []}
                    include={(id, checked) => {
                      setAudience('include', 'teamSeasonIds', id, checked);
                    }}
                    exclude={(id, checked) => {
                      setAudience('exclude', 'teamSeasonIds', id, checked);
                    }}
                  />
                  <SelectorGroup
                    disabled={!canEdit}
                    title="Programs"
                    items={options.programs}
                    selected={draft.audience.include.programIds ?? []}
                    excluded={draft.audience.exclude.programIds ?? []}
                    include={(id, checked) => {
                      setAudience('include', 'programIds', id, checked);
                    }}
                    exclude={(id, checked) => {
                      setAudience('exclude', 'programIds', id, checked);
                    }}
                  />
                  <fieldset className="messages-selector">
                    <legend>Roles</legend>
                    {roleOptions.map((item) => (
                      <div className="messages-selector-row" key={item.id}>
                        <label>
                          <Checkbox
                            disabled={!canEdit}
                            checked={(
                              draft.audience.include.roles ?? []
                            ).includes(item.id)}
                            onChange={(event) => {
                              setAudience(
                                'include',
                                'roles',
                                item.id,
                                event.target.checked,
                              );
                            }}
                          />
                          {item.label}
                        </label>
                        <label className="messages-exclude">
                          <Checkbox
                            disabled={!canEdit}
                            checked={(
                              draft.audience.exclude.roles ?? []
                            ).includes(item.id)}
                            onChange={(event) => {
                              setAudience(
                                'exclude',
                                'roles',
                                item.id,
                                event.target.checked,
                              );
                            }}
                          />
                          Exclude
                        </label>
                      </div>
                    ))}
                  </fieldset>
                </div>
                <fieldset className="messages-selector messages-audience-filters">
                  <legend>Refine audience</legend>
                  <Field label="Registration status">
                    <Select
                      disabled={!canEdit}
                      value={
                        draft.audience.filters.registrationStatuses?.[0] ?? ''
                      }
                      onChange={(event) => {
                        setAudienceFilter(
                          'registrationStatuses',
                          event.target.value,
                        );
                      }}
                      options={[
                        { value: '', label: 'Any registration status' },
                        { value: 'pending_payment', label: 'Pending payment' },
                        {
                          value: 'pending_approval',
                          label: 'Pending approval',
                        },
                        { value: 'waitlisted', label: 'Waitlisted' },
                        { value: 'offered', label: 'Offered' },
                        { value: 'confirmed', label: 'Confirmed' },
                        { value: 'canceled', label: 'Canceled' },
                        { value: 'withdrawn', label: 'Withdrawn' },
                        { value: 'transferred_out', label: 'Transferred out' },
                      ]}
                    />
                  </Field>
                  <label className="messages-filter-checkbox">
                    <Checkbox
                      disabled={!canEdit}
                      checked={draft.audience.filters.pastDueBalance ?? false}
                      onChange={(event) => {
                        setAudienceFilter(
                          'pastDueBalance',
                          event.target.checked,
                        );
                      }}
                    />
                    Bill-to account has a past-due balance
                  </label>
                </fieldset>
              </section>
              <section
                className="messages-content"
                aria-labelledby="content-heading"
              >
                <div className="messages-section-title">
                  <div>
                    <h3 id="content-heading">Message content</h3>
                    <p>
                      English and Spanish variants are delivered using each
                      recipient’s saved language.
                    </p>
                  </div>
                  <div
                    className="messages-locale-tabs"
                    role="tablist"
                    aria-label="Message language"
                  >
                    <Button
                      type="button"
                      secondary={locale !== 'en'}
                      role="tab"
                      aria-selected={locale === 'en'}
                      onClick={() => {
                        setLocale('en');
                      }}
                    >
                      English
                    </Button>
                    <Button
                      type="button"
                      secondary={locale !== 'es'}
                      role="tab"
                      aria-selected={locale === 'es'}
                      onClick={() => {
                        setLocale('es');
                      }}
                    >
                      Español
                    </Button>
                  </div>
                </div>
                <div className="messages-grid">
                  <Field label="Subject">
                    <Input
                      disabled={!canEdit}
                      value={copy.subject}
                      maxLength={200}
                      onChange={(event) => {
                        editLocale('subject', event.target.value);
                      }}
                    />
                  </Field>
                  <Field
                    label="Email content"
                    hint="Supported merge fields: guardian.first_name, athlete.first_name, athlete.last_name, team.name, program.name and event.next.start."
                  >
                    <RichTextEditor
                      disabled={!canEdit}
                      value={copy.bodyHtml}
                      onChange={(value) => {
                        editLocale('bodyHtml', value);
                      }}
                      label={`${locale === 'en' ? 'English' : 'Spanish'} email content`}
                      maxLength={100_000}
                    />
                  </Field>
                  <Field label="Plain text">
                    <Textarea
                      disabled={!canEdit}
                      rows={4}
                      value={copy.bodyText}
                      onChange={(event) => {
                        editLocale('bodyText', event.target.value);
                      }}
                    />
                  </Field>
                  <Field
                    label="SMS copy"
                    hint="A localized STOP/HELP compliance footer is added at send time."
                  >
                    <Textarea
                      disabled={!canEdit}
                      rows={3}
                      maxLength={1600}
                      value={copy.smsText}
                      onChange={(event) => {
                        editLocale('smsText', event.target.value);
                      }}
                    />
                    <small className="messages-sms-count">
                      {smsSegments(copy.smsText)} SMS segment
                      {smsSegments(copy.smsText) === 1 ? '' : 's'} before
                      compliance footer
                    </small>
                  </Field>
                  <Field label="Push copy">
                    <Input
                      disabled={!canEdit}
                      value={copy.pushText}
                      maxLength={500}
                      onChange={(event) => {
                        editLocale('pushText', event.target.value);
                      }}
                    />
                  </Field>
                </div>
                <div className="messages-merge-tools">
                  <span>Append merge field to email</span>
                  {[
                    '{{guardian.first_name}}',
                    '{{athlete.first_name}}',
                    '{{athlete.last_name}}',
                    '{{team.name}}',
                    '{{program.name}}',
                    '{{event.next.start}}',
                  ].map((field) => (
                    <Button
                      key={field}
                      type="button"
                      secondary
                      disabled={!canEdit}
                      onClick={() => {
                        editLocale(
                          'bodyHtml',
                          `${copy.bodyHtml}<p>${field}</p>`,
                        );
                      }}
                    >
                      {field}
                    </Button>
                  ))}
                </div>
              </section>
              <div className="messages-actions">
                <Button
                  disabled={busy || !draft.channels.length || !canEdit}
                  onClick={() => void save()}
                >
                  Save draft
                </Button>
                <Button
                  secondary
                  disabled={busy}
                  onClick={() => void getPreview()}
                >
                  Preview audience
                </Button>
                <Button
                  secondary
                  disabled={
                    busy ||
                    !selectedId ||
                    !['draft', 'scheduled'].includes(status)
                  }
                  onClick={() => void testSend()}
                >
                  Send test to me
                </Button>
                <Button
                  secondary
                  disabled={busy || !draft.channels.length || !canEdit}
                  onClick={() => void send()}
                >
                  Send now
                </Button>
                <Button
                  secondary
                  disabled={busy || !selectedId}
                  onClick={() => void loadStats()}
                >
                  Delivery stats
                </Button>
              </div>
              {stats && (
                <section className="messages-preview" aria-live="polite">
                  <h3>Delivery statistics · {stats.status}</h3>
                  {Object.entries(stats.counts).map(([channel, counts]) => (
                    <div key={channel}>
                      <strong>{channel}</strong>
                      <ul>
                        {Object.entries(counts).map(
                          ([deliveryStatus, count]) => (
                            <li key={deliveryStatus}>
                              {deliveryStatus}: {count}
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  ))}
                </section>
              )}
              {preview && (
                <div className="messages-preview" aria-live="polite">
                  <h3>Audience preview · {preview.recipientCount} people</h3>
                  <ul>
                    {Object.entries(preview.counts).map(([channel, count]) => (
                      <li key={channel}>
                        <strong>{channel}</strong>
                        <span>{count} eligible destinations</span>
                      </li>
                    ))}
                  </ul>
                  <p>
                    Showing up to 50 people with guardian routing already
                    applied.
                  </p>
                </div>
              )}
              <div className="messages-schedule">
                <Field label="Schedule date and time">
                  <Input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(event) => {
                      setScheduleAt(event.target.value);
                    }}
                  />
                </Field>
                <Button
                  secondary
                  disabled={
                    busy || !scheduleAt || !['new', 'draft'].includes(status)
                  }
                  onClick={() => void schedule()}
                >
                  Schedule
                </Button>
                {status === 'scheduled' && (
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => void cancel()}
                  >
                    Cancel schedule
                  </Button>
                )}
              </div>
            </Card>
          </section>
        </div>
      )}
    </main>
  );
}

function SelectorGroup({
  title,
  items,
  selected,
  excluded,
  include,
  exclude,
  disabled = false,
}: {
  title: string;
  items: { id: string; label: string }[];
  selected: string[];
  excluded: string[];
  include: (id: string, checked: boolean) => void;
  exclude: (id: string, checked: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <fieldset className="messages-selector">
      <legend>{title}</legend>
      {items.length ? (
        items.map((item) => (
          <div className="messages-selector-row" key={item.id}>
            <label>
              <Checkbox
                disabled={disabled}
                checked={selected.includes(item.id)}
                onChange={(event) => {
                  include(item.id, event.target.checked);
                }}
              />
              {item.label}
            </label>
            <label className="messages-exclude">
              <Checkbox
                disabled={disabled}
                checked={excluded.includes(item.id)}
                onChange={(event) => {
                  exclude(item.id, event.target.checked);
                }}
              />
              Exclude
            </label>
          </div>
        ))
      ) : (
        <p>No matches. Search to find another result.</p>
      )}
    </fieldset>
  );
}

function smsSegments(text: string): number {
  const basic = new Set(
    Array.from(
      '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
    ),
  );
  const extended = new Set([
    '^',
    '{',
    '}',
    '\\',
    '[',
    ']',
    '~',
    '|',
    '€',
    '\f',
  ]);
  let units = 0;
  let gsm = true;
  for (const character of text) {
    if (basic.has(character)) units += 1;
    else if (extended.has(character)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) units = text.length;
  const limit = gsm ? 160 : 70;
  return units <= limit ? 1 : Math.ceil(units / (gsm ? 153 : 67));
}

type SenderIdentity = {
  displayName: string | null;
  replyTo: string | null;
  replyToVerified: boolean;
  smsComplianceText: string | null;
  version: number;
};
function SenderIdentityPanel({ orgId }: { orgId: string }): React.JSX.Element {
  const [identity, setIdentity] = useState<SenderIdentity | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [smsComplianceText, setSmsComplianceText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const path = `/orgs/${encodeURIComponent(orgId)}/sender-identity`;
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await communicationsRequest<SenderIdentity>(path);
      setIdentity(result);
      setDisplayName(result.displayName ?? '');
      setReplyTo(result.replyTo ?? '');
      setSmsComplianceText(result.smsComplianceText ?? '');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load sender settings.',
      );
    } finally {
      setBusy(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identity) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await communicationsRequest<{
        identity: SenderIdentity;
        verificationSent: boolean;
      }>(path, 'PUT', {
        displayName: displayName.trim() || null,
        replyTo: replyTo.trim() || null,
        smsComplianceText: smsComplianceText.trim() || null,
        expectedVersion: identity.version,
      });
      setIdentity(result.identity);
      setNotice(
        result.verificationSent
          ? 'Sender settings saved. Check the reply-to inbox to verify the address.'
          : 'Sender settings saved.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save sender settings.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="messages-settings">
      <h2>Sender identity</h2>
      <p>
        Organization messages use this display name and verified reply-to
        address. SMS compliance text must include STOP and HELP instructions.
      </p>
      {error && (
        <div role="alert" className="messages-alert messages-alert--error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="messages-alert">
          {notice}
        </div>
      )}
      <form
        className="messages-settings-form"
        onSubmit={(event) => void save(event)}
      >
        <Field label="Sender display name">
          <Input
            value={displayName}
            maxLength={120}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
        </Field>
        <Field
          label="Reply-to email"
          hint={
            identity?.replyToVerified
              ? 'Verified'
              : 'A verification message is sent when this address changes.'
          }
        >
          <Input
            type="email"
            value={replyTo}
            maxLength={254}
            onChange={(event) => {
              setReplyTo(event.target.value);
            }}
          />
        </Field>
        <Field label="SMS compliance text">
          <Textarea
            value={smsComplianceText}
            maxLength={320}
            rows={3}
            onChange={(event) => {
              setSmsComplianceText(event.target.value);
            }}
          />
        </Field>
        <Button type="submit" disabled={busy || !identity}>
          Save sender settings
        </Button>
      </form>
    </Card>
  );
}

type ModerationReport = {
  reportId: string;
  incidentReportId: string;
  messageId: string;
  conversationId: string;
  reportedBy: string;
  reason: string;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  createdAt: string;
  version: number;
};
function ModerationPanel({ orgId }: { orgId: string }): React.JSX.Element {
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const path = `/orgs/${encodeURIComponent(orgId)}/chat/moderation/reports`;
  const load = useCallback(async () => {
    setError('');
    try {
      const result = await communicationsRequest<{ items: ModerationReport[] }>(
        path,
      );
      setReports(result.items);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load moderation reports.',
      );
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  const update = async (
    report: ModerationReport,
    status: 'reviewing' | 'resolved' | 'dismissed',
  ) => {
    setBusyId(report.reportId);
    setError('');
    try {
      const result = await communicationsRequest<{
        id: string;
        status: ModerationReport['status'];
        version: number;
      }>(`${path}/${encodeURIComponent(report.reportId)}`, 'PUT', {
        status,
        expectedVersion: report.version,
      });
      setReports((items) =>
        items.map((item) =>
          item.reportId === report.reportId
            ? { ...item, status: result.status, version: result.version }
            : item,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not update report.',
      );
    } finally {
      setBusyId('');
    }
  };
  return (
    <Card className="messages-moderation">
      <div className="messages-panel-title">
        <div>
          <h2>Chat moderation reports</h2>
          <p>Reports are linked to restricted compliance incidents.</p>
        </div>
        <Button
          type="button"
          secondary
          disabled={Boolean(busyId)}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <div role="alert" className="messages-alert messages-alert--error">
          {error}
        </div>
      )}
      {reports.length ? (
        <ul className="messages-report-list">
          {reports.map((report) => (
            <li key={report.reportId}>
              <div>
                <strong>{report.reason.replaceAll('_', ' ')}</strong>
                <p>
                  Status: {report.status} ·{' '}
                  {new Date(report.createdAt).toLocaleString()}
                </p>
                <p>Incident: {report.incidentReportId}</p>
              </div>
              <div className="messages-report-actions">
                <Button
                  type="button"
                  secondary
                  disabled={Boolean(busyId) || report.status !== 'open'}
                  onClick={() => void update(report, 'reviewing')}
                >
                  Review
                </Button>
                <Button
                  type="button"
                  secondary
                  disabled={
                    Boolean(busyId) ||
                    ['resolved', 'dismissed'].includes(report.status)
                  }
                  onClick={() => void update(report, 'resolved')}
                >
                  Resolve
                </Button>
                <Button
                  type="button"
                  secondary
                  disabled={
                    Boolean(busyId) ||
                    ['resolved', 'dismissed'].includes(report.status)
                  }
                  onClick={() => void update(report, 'dismissed')}
                >
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No chat reports are available.</p>
      )}
    </Card>
  );
}

type ChatMemberOption = { accountId: string; label: string };
type CreatedChatChannel = {
  id: string;
  kind: 'announcement' | 'group';
  title: string | null;
};

function ChatChannelsPanel({ orgId }: { orgId: string }): React.JSX.Element {
  const [kind, setKind] = useState<'announcement' | 'group'>('announcement');
  const [title, setTitle] = useState('');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<ChatMemberOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedChatChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/orgs/${encodeURIComponent(orgId)}/chat`;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void communicationsRequest<{ items: ChatMemberOption[] }>(
        `${base}/member-options${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`,
      )
        .then((result) => {
          if (!cancelled) setOptions(result.items);
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not load chat members.',
            );
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, search]);

  const toggleMember = (accountId: string, checked: boolean) => {
    setSelectedIds((items) =>
      checked
        ? [...new Set([...items, accountId])]
        : items.filter((item) => item !== accountId),
    );
    setCreated(null);
  };

  const create = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setCreated(null);
    try {
      const result = await communicationsRequest<CreatedChatChannel>(
        `${base}/conversations`,
        'POST',
        { kind, title: title.trim(), accountIds: selectedIds },
      );
      setCreated(result);
      setTitle('');
      setSelectedIds([]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not create channel.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="messages-moderation">
      <div className="messages-panel-title">
        <div>
          <h2>Create a chat channel</h2>
          <p>
            Announcement members can read messages; group members can reply.
            Guardians are added automatically when SafeSport requires it.
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="messages-alert messages-alert--error">
          {error}
        </div>
      )}
      {created && (
        <div role="status" className="messages-preview">
          <p>
            {created.kind === 'announcement' ? 'Announcement' : 'Group'} channel
            created: <strong>{created.title}</strong>.
          </p>
          <Button
            type="button"
            secondary
            onClick={() => {
              window.location.assign(
                `/me/orgs/${encodeURIComponent(orgId)}/messages?conversation=${encodeURIComponent(created.id)}`,
              );
            }}
          >
            Open conversation
          </Button>
        </div>
      )}
      <form onSubmit={(event) => void create(event)}>
        <div className="messages-grid messages-grid--short">
          <Field label="Channel type">
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
              }}
              options={[
                { value: 'announcement', label: 'Announcement only' },
                { value: 'group', label: 'Group conversation' },
              ]}
            />
          </Field>
          <Field label="Channel name">
            <Input
              required
              maxLength={120}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </Field>
        </div>
        <Field label="Search organization members">
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search by name or email"
          />
        </Field>
        <fieldset className="messages-selector">
          <legend>Members · {selectedIds.length} selected</legend>
          {options.length ? (
            options.map((option) => (
              <label className="messages-selector-row" key={option.accountId}>
                <Checkbox
                  checked={selectedIds.includes(option.accountId)}
                  onChange={(event) => {
                    toggleMember(option.accountId, event.target.checked);
                  }}
                />
                {option.label}
              </label>
            ))
          ) : (
            <p>No matching members.</p>
          )}
        </fieldset>
        <Button disabled={busy || !title.trim() || selectedIds.length === 0}>
          {busy ? 'Creating…' : 'Create channel'}
        </Button>
      </form>
    </Card>
  );
}
