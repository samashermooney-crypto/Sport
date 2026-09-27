import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { Button, Card, Field, FileUpload, Select, Textarea } from '../../ui';

import './portal-messages.css';

type Conversation = {
  id: string;
  kind: string;
  title: string | null;
  teamSeasonId: string | null;
  guardianCopied: boolean;
  muted: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
};
type ChatMessage = {
  id: string;
  conversationId: string;
  authorAccountId: string;
  authorName: string;
  body: string;
  attachments: { fileId: string; mime: string }[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  readByCount: number;
  version: number;
};
type SmsConsent = {
  accepted: boolean;
  phoneE164: string | null;
  acceptedAt: string | null;
  locale: 'en' | 'es' | null;
};
type AttachmentCapabilities = { canUpload: boolean; canDownload: boolean };

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  orgId?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      path.startsWith('/api/v1/') ? path : `/api/v1/communications${path}`,
      {
        method,
        credentials: 'include',
        ...(method === 'GET'
          ? {}
          : {
              headers: {
                'Content-Type': 'application/json',
                'X-Athlentry-Request': '1',
                ...(orgId ? { 'X-Athlentry-Org': orgId } : {}),
              },
            }),
        ...(method === 'GET'
          ? orgId
            ? { headers: { 'X-Athlentry-Org': orgId } }
            : {}
          : { body: JSON.stringify(body ?? {}) }),
      },
    );
  } catch {
    throw new Error('Cannot connect. Check your connection and try again.');
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      result && typeof result === 'object' && 'error' in result
        ? result.error
        : null;
    throw new Error(
      error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
        ? error.message
        : 'The request could not be completed.',
    );
  }
  return result as T;
}

export function MessagesPortal({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [teams, setTeams] = useState<
    { teamSeasonId: string; label: string; staffAccess: boolean }[]
  >([]);
  const [activeConversation, setActiveConversation] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [smsConsent, setSmsConsent] = useState<SmsConsent | null>(null);
  const [attachmentCapabilities, setAttachmentCapabilities] =
    useState<AttachmentCapabilities>({ canUpload: false, canDownload: false });
  const [consentChecked, setConsentChecked] = useState(false);
  const [liveState, setLiveState] = useState('connecting');
  const [reportId, setReportId] = useState('');
  const [reportReason, setReportReason] = useState('safesport_concern');
  const [reportDetails, setReportDetails] = useState('');
  const [accountId, setAccountId] = useState('');
  const base = `/orgs/${encodeURIComponent(orgId)}`;
  const requestedConversationId = searchParams.get('conversation');

  const loadConversations = useCallback(async () => {
    const [result, available, attachmentAccess] = await Promise.all([
      request<{ items: Conversation[] }>(`${base}/chat/conversations`),
      request<{
        items: { teamSeasonId: string; label: string; staffAccess: boolean }[];
      }>(`${base}/chat/teams`),
      request<AttachmentCapabilities>(`${base}/chat/attachment-capabilities`),
    ]);
    setConversations(result.items);
    setTeams(available.items);
    setAttachmentCapabilities(attachmentAccess);
    if (
      activeConversation &&
      !result.items.some((item) => item.id === activeConversation)
    )
      setActiveConversation('');
  }, [base, activeConversation]);
  const loadMessages = useCallback(
    async (conversationId = activeConversation) => {
      if (!conversationId) {
        setMessages([]);
        return;
      }
      const result = await request<{
        items: ChatMessage[];
        nextCursor: string | null;
      }>(
        `${base}/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`,
      );
      setMessages(result.items.reverse());
    },
    [base, activeConversation],
  );
  const loadSmsConsent = useCallback(async () => {
    setSmsConsent(await request<SmsConsent>(`${base}/sms-consent`));
  }, [base]);

  useEffect(() => {
    let active = true;
    void loadConversations().catch((cause: unknown) => {
      if (active)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load conversations.',
        );
    });
    return () => {
      active = false;
    };
  }, [loadConversations]);
  useEffect(() => {
    if (requestedConversationId) setActiveConversation(requestedConversationId);
  }, [requestedConversationId]);
  useEffect(() => {
    let active = true;
    void loadSmsConsent().catch((cause: unknown) => {
      if (active)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load SMS consent.',
        );
    });
    return () => {
      active = false;
    };
  }, [loadSmsConsent]);
  useEffect(() => {
    void request<{ id: string }>('/api/v1/auth/me')
      .then((result) => {
        setAccountId(result.id);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    let active = true;
    void loadMessages().catch((cause: unknown) => {
      if (active)
        setError(
          cause instanceof Error ? cause.message : 'Could not load messages.',
        );
    });
    return () => {
      active = false;
    };
  }, [loadMessages]);
  useEffect(() => {
    const source = new EventSource('/api/v1/stream', { withCredentials: true });
    const onNotification = () => {
      void loadConversations().catch(() => undefined);
      void loadMessages().catch(() => undefined);
    };
    source.addEventListener('open', () => {
      setLiveState('live');
    });
    source.addEventListener('error', () => {
      setLiveState('reconnecting');
    });
    source.addEventListener('notification', onNotification);
    return () => {
      source.close();
    };
  }, [loadConversations, loadMessages]);

  const selectConversation = async (id: string) => {
    setActiveConversation(id);
    setError('');
    await request(
      `${base}/chat/conversations/${encodeURIComponent(id)}/read`,
      'POST',
    );
    await loadMessages(id);
    await loadConversations();
  };
  const openTeam = async (
    teamSeasonId: string,
    kind: 'team' | 'team_staff' = 'team',
  ) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<Conversation>(
        `${base}/chat/conversations`,
        'POST',
        { kind, teamSeasonId, accountIds: [] },
      );
      setActiveConversation(result.id);
      await loadConversations();
      await loadMessages(result.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not open team conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  const sendMessage = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeConversation || (!body.trim() && !attachmentIds.length)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(
        `${base}/chat/conversations/${encodeURIComponent(activeConversation)}/messages`,
        'POST',
        { body: body.trim() || 'Attachment', attachments: attachmentIds },
      );
      setBody('');
      setAttachmentIds([]);
      await loadMessages();
      await loadConversations();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not send message.',
      );
    } finally {
      setBusy(false);
    }
  };
  const uploadFile = async (file: File) => {
    const mime = file.type;
    if (!(mime.startsWith('image/') || mime === 'application/pdf')) {
      setError('Choose a supported image or PDF.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('Files must be 15 MB or smaller.');
      return;
    }
    const purpose = mime.startsWith('image/') ? 'image' : 'document';
    const headers = {
      'Content-Type': 'application/json',
      'X-Athlentry-Request': '1',
      'X-Athlentry-Org': orgId,
    };
    try {
      const created = await fetch('/api/v1/files/uploads', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          purpose,
          mime,
          bytes: file.size,
          sensitivity: 'internal',
        }),
      });
      if (!created.ok) throw new Error('File upload could not start.');
      const { fileId, uploadUrl } = (await created.json()) as {
        fileId: string;
        uploadUrl: string;
      };
      const uploaded = await fetch(uploadUrl, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'X-Athlentry-Request': '1',
          'X-Athlentry-Org': orgId,
          'Content-Type': 'application/octet-stream',
        },
        body: await file.arrayBuffer(),
      });
      if (!uploaded.ok) throw new Error('File upload failed.');
      const completed = await fetch(
        `/api/v1/files/uploads/${encodeURIComponent(fileId)}/complete`,
        { method: 'POST', credentials: 'include', headers, body: '{}' },
      );
      if (!completed.ok) throw new Error('File could not be finalized.');
      setAttachmentIds((items) => [...items, fileId]);
      setNotice(`${file.name} is ready to attach.`);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'File upload failed.');
    }
  };
  const downloadAttachment = async (fileId: string) => {
    try {
      const response = await fetch(
        `/api/v1/files/${encodeURIComponent(fileId)}/content`,
        { credentials: 'include', headers: { 'X-Athlentry-Org': orgId } },
      );
      if (!response.ok) throw new Error('Attachment is not available.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `chat-${fileId}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not download attachment.',
      );
    }
  };
  const report = async (messageId: string) => {
    if (!activeConversation) return;
    setBusy(true);
    setError('');
    try {
      await request(
        `${base}/chat/conversations/${encodeURIComponent(activeConversation)}/messages/${encodeURIComponent(messageId)}/report`,
        'POST',
        {
          reason: reportReason,
          ...(reportDetails.trim() ? { details: reportDetails.trim() } : {}),
        },
      );
      setReportId('');
      setReportDetails('');
      setNotice('Your report was sent to the organization compliance team.');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not submit the report.',
      );
    } finally {
      setBusy(false);
    }
  };
  const setSms = async () => {
    if (!smsConsent?.phoneE164) return;
    setBusy(true);
    setError('');
    try {
      const result = smsConsent.accepted
        ? await request<SmsConsent>(`${base}/sms-consent`, 'DELETE')
        : await request<SmsConsent>(`${base}/sms-consent`, 'POST', {
            phoneE164: smsConsent.phoneE164,
            accepted: true,
            version: `sms-v1-${smsConsent.locale ?? 'en'}`,
          });
      setSmsConsent(result);
      setConsentChecked(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not update SMS consent.',
      );
    } finally {
      setBusy(false);
    }
  };

  const consentText =
    smsConsent?.locale === 'es'
      ? 'Acepto recibir mensajes SMS recurrentes de esta organización. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para cancelar o HELP para obtener ayuda. El consentimiento no es condición para participar.'
      : 'I agree to receive recurring SMS messages from this organization. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of participation.';

  return (
    <main className="portal-messages">
      <header className="portal-messages__header">
        <div>
          <p className="portal-messages__eyebrow">FAMILY PORTAL</p>
          <h1>Messages</h1>
          <p>Stay connected with your teams and organization.</p>
        </div>
        <span className="portal-live" role="status">
          {liveState === 'live'
            ? 'Live updates on'
            : 'Live updates reconnecting'}
        </span>
      </header>
      {error && (
        <div
          role="alert"
          className="portal-message-alert portal-message-alert--error"
        >
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="portal-message-alert">
          {notice}
        </div>
      )}
      <nav className="portal-message-tabs" aria-label="Message center sections">
        <Button
          type="button"
          secondary
          onClick={() => {
            void navigate(
              `/portal/orgs/${encodeURIComponent(orgId)}/notifications`,
            );
          }}
        >
          Notifications and preferences
        </Button>
      </nav>
      <div className="portal-chat-layout">
        <Card className="portal-chat-list">
          <h2>Conversations</h2>
          {teams.length > 0 && (
            <>
              <fieldset className="portal-team-list">
                <legend>Team chats</legend>
                {teams.map((team) => (
                  <Button
                    key={team.teamSeasonId}
                    type="button"
                    secondary
                    disabled={busy}
                    onClick={() => void openTeam(team.teamSeasonId)}
                  >
                    {team.label}
                  </Button>
                ))}
              </fieldset>
              {teams.some((team) => team.staffAccess) && (
                <fieldset className="portal-team-list">
                  <legend>Staff channels</legend>
                  {teams
                    .filter((team) => team.staffAccess)
                    .map((team) => (
                      <Button
                        key={team.teamSeasonId}
                        type="button"
                        secondary
                        disabled={busy}
                        onClick={() =>
                          void openTeam(team.teamSeasonId, 'team_staff')
                        }
                      >
                        {team.label} staff
                      </Button>
                    ))}
                </fieldset>
              )}
            </>
          )}
          {conversations.length ? (
            <ul>
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    className={
                      activeConversation === conversation.id ? 'is-active' : ''
                    }
                    type="button"
                    onClick={() => void selectConversation(conversation.id)}
                  >
                    <span>
                      {conversation.title ||
                        (conversation.kind === 'team'
                          ? 'Team conversation'
                          : 'Direct message')}
                    </span>
                    <small>
                      {conversation.guardianCopied
                        ? 'Guardian included'
                        : conversation.kind.replace('_', ' ')}
                      {conversation.unreadCount
                        ? ` · ${String(conversation.unreadCount)} unread`
                        : ''}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : teams.length ? (
            <p>Choose a team above to open its conversation.</p>
          ) : (
            <p>No conversations are available for this account.</p>
          )}
        </Card>
        <section className="portal-chat-thread" aria-label="Conversation">
          {activeConversation ? (
            <Card>
              <div className="portal-thread-heading">
                <h2>
                  {conversations.find((item) => item.id === activeConversation)
                    ?.title || 'Conversation'}
                </h2>
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    const muted =
                      conversations.find(
                        (item) => item.id === activeConversation,
                      )?.muted ?? false;
                    void request(
                      `${base}/chat/conversations/${encodeURIComponent(activeConversation)}/mute`,
                      'PUT',
                      { muted: !muted },
                    )
                      .then(() => {
                        setConversations((rows) =>
                          rows.map((row) =>
                            row.id === activeConversation
                              ? { ...row, muted: !muted }
                              : row,
                          ),
                        );
                        setNotice(
                          muted
                            ? 'Conversation unmuted.'
                            : 'Conversation muted.',
                        );
                      })
                      .catch((cause: unknown) => {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : 'Could not update mute setting.',
                        );
                      });
                  }}
                >
                  {conversations.find((item) => item.id === activeConversation)
                    ?.muted
                    ? 'Unmute'
                    : 'Mute'}
                </Button>
              </div>
              <ol className="portal-message-list" aria-live="polite">
                {messages.map((message) => (
                  <li key={message.id}>
                    <article>
                      <header>
                        <strong>{message.authorName}</strong>
                        <time dateTime={message.createdAt}>
                          {new Date(message.createdAt).toLocaleString()}
                        </time>
                      </header>
                      <p>{message.body}</p>
                      {message.attachments.length > 0 && (
                        <ul className="portal-attachments">
                          {message.attachments.map((attachment) => (
                            <li key={attachment.fileId}>
                              {attachmentCapabilities.canDownload ? (
                                <Button
                                  type="button"
                                  secondary
                                  onClick={() =>
                                    void downloadAttachment(attachment.fileId)
                                  }
                                >
                                  Download attachment ({attachment.mime})
                                </Button>
                              ) : (
                                <span>Attachment access unavailable</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {message.deletedAt ? (
                        <p className="portal-removed">
                          This message was removed.
                        </p>
                      ) : (
                        <div className="portal-message-actions">
                          <Button
                            type="button"
                            secondary
                            onClick={() => {
                              setReportId(
                                reportId === message.id ? '' : message.id,
                              );
                              setReportDetails('');
                            }}
                          >
                            Report
                          </Button>
                          {message.authorAccountId === accountId && (
                            <Button
                              type="button"
                              secondary
                              onClick={() => {
                                if (
                                  window.confirm(
                                    'Hide this message for participants?',
                                  )
                                )
                                  void request(
                                    `${base}/chat/conversations/${encodeURIComponent(activeConversation)}/messages/${encodeURIComponent(message.id)}`,
                                    'DELETE',
                                  )
                                    .then(() => loadMessages())
                                    .catch((cause: unknown) => {
                                      setError(
                                        cause instanceof Error
                                          ? cause.message
                                          : 'Could not hide message.',
                                      );
                                    });
                              }}
                            >
                              Hide
                            </Button>
                          )}
                        </div>
                      )}
                      {reportId === message.id && (
                        <form
                          className="portal-report-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void report(message.id);
                          }}
                        >
                          <Field label="Report reason">
                            <Select
                              value={reportReason}
                              onChange={(event) => {
                                setReportReason(event.target.value);
                              }}
                              options={[
                                {
                                  value: 'safesport_concern',
                                  label: 'SafeSport concern',
                                },
                                { value: 'harassment', label: 'Harassment' },
                                {
                                  value: 'inappropriate_content',
                                  label: 'Inappropriate content',
                                },
                                { value: 'other', label: 'Other' },
                              ]}
                            />
                          </Field>
                          <Field label="Details (optional)">
                            <Textarea
                              rows={3}
                              maxLength={2000}
                              value={reportDetails}
                              onChange={(event) => {
                                setReportDetails(event.target.value);
                              }}
                            />
                          </Field>
                          <Button disabled={busy} type="submit">
                            Send report
                          </Button>
                        </form>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
              <form
                className="portal-compose"
                onSubmit={(event) => void sendMessage(event)}
              >
                <Field label="Write a message">
                  <Textarea
                    rows={3}
                    maxLength={5000}
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                    }}
                  />
                </Field>
                <div className="portal-compose__actions">
                  {attachmentCapabilities.canUpload && (
                    <FileUpload
                      label="Attach image or PDF"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onFiles={(files) => {
                        const file = files?.[0];
                        if (file) void uploadFile(file);
                      }}
                    />
                  )}
                  {attachmentIds.length > 0 && (
                    <span>{attachmentIds.length} attachment ready</span>
                  )}
                  <Button
                    disabled={
                      busy || (!body.trim() && attachmentIds.length === 0)
                    }
                    type="submit"
                  >
                    Send message
                  </Button>
                </div>
              </form>
            </Card>
          ) : (
            <Card className="portal-empty-thread">
              <h2>Choose a conversation</h2>
              <p>
                Your team conversations include guardians when an athlete under
                18 participates.
              </p>
            </Card>
          )}
        </section>
      </div>
      <Card>
        <h2>Text message consent</h2>
        {smsConsent?.phoneE164 ? (
          <>
            <p>
              Phone on file: <strong>{smsConsent.phoneE164}</strong>
            </p>
            {!smsConsent.accepted && (
              <label className="portal-consent">
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(event) => {
                    setConsentChecked(event.target.checked);
                  }}
                />
                <span>{consentText}</span>
              </label>
            )}
            <Button
              disabled={busy || (!smsConsent.accepted && !consentChecked)}
              onClick={() => void setSms()}
            >
              {smsConsent.accepted
                ? 'Turn off SMS messages'
                : 'Agree and enable SMS'}
            </Button>
          </>
        ) : (
          <p>
            A verified phone number is required before SMS consent can be
            recorded.
          </p>
        )}
      </Card>
    </main>
  );
}
