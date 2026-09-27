import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { i18n as appI18n } from '../../lib/i18n';
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
    throw new Error(appI18n.t('portal:messageCenter.connectFailed'));
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
        : appI18n.t('portal:messageCenter.requestFailed'),
    );
  }
  return result as T;
}

export function MessagesPortal({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const { t, i18n } = useTranslation('portal');
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
            : t('messageCenter.conversationsLoadFailed'),
        );
    });
    return () => {
      active = false;
    };
  }, [loadConversations, t]);
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
            : t('messageCenter.consentLoadFailed'),
        );
    });
    return () => {
      active = false;
    };
  }, [loadSmsConsent, t]);
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
          cause instanceof Error
            ? cause.message
            : t('messageCenter.messagesLoadFailed'),
        );
    });
    return () => {
      active = false;
    };
  }, [loadMessages, t]);
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
          : t('messageCenter.teamOpenFailed'),
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
        {
          body: body.trim() || t('messageCenter.attachmentBody'),
          attachments: attachmentIds,
        },
      );
      setBody('');
      setAttachmentIds([]);
      await loadMessages();
      await loadConversations();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('messageCenter.messageSendFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  const uploadFile = async (file: File) => {
    const mime = file.type;
    if (!(mime.startsWith('image/') || mime === 'application/pdf')) {
      setError(t('messageCenter.unsupportedFile'));
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError(t('messageCenter.fileTooLarge'));
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
      if (!created.ok) throw new Error(t('messageCenter.uploadStartFailed'));
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
      if (!uploaded.ok) throw new Error(t('messageCenter.uploadFailed'));
      const completed = await fetch(
        `/api/v1/files/uploads/${encodeURIComponent(fileId)}/complete`,
        { method: 'POST', credentials: 'include', headers, body: '{}' },
      );
      if (!completed.ok)
        throw new Error(t('messageCenter.uploadFinalizeFailed'));
      setAttachmentIds((items) => [...items, fileId]);
      setNotice(t('messageCenter.fileReady', { name: file.name }));
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('messageCenter.uploadFailed'),
      );
    }
  };
  const downloadAttachment = async (fileId: string) => {
    try {
      const response = await fetch(
        `/api/v1/files/${encodeURIComponent(fileId)}/content`,
        { credentials: 'include', headers: { 'X-Athlentry-Org': orgId } },
      );
      if (!response.ok)
        throw new Error(t('messageCenter.attachmentUnavailableError'));
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
          : t('messageCenter.downloadFailed'),
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
      setNotice(t('messageCenter.reportSent'));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('messageCenter.reportFailed'),
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
          : t('messageCenter.consentUpdateFailed'),
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
          <p className="portal-messages__eyebrow">
            {t('messageCenter.eyebrow')}
          </p>
          <h1>{t('messageCenter.messageTitle')}</h1>
          <p>{t('messageCenter.messageSubtitle')}</p>
        </div>
        <span className="portal-live" role="status">
          {liveState === 'live'
            ? t('messageCenter.liveOn')
            : t('messageCenter.liveReconnecting')}
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
      <nav
        className="portal-message-tabs"
        aria-label={t('messageCenter.messageSections')}
      >
        <Button
          type="button"
          secondary
          onClick={() => {
            void navigate(
              `/portal/orgs/${encodeURIComponent(orgId)}/notifications`,
            );
          }}
        >
          {t('messageCenter.notificationsAndPreferences')}
        </Button>
      </nav>
      <div className="portal-chat-layout">
        <Card className="portal-chat-list">
          <h2>{t('messageCenter.conversations')}</h2>
          {teams.length > 0 && (
            <>
              <fieldset className="portal-team-list">
                <legend>{t('messageCenter.teamChats')}</legend>
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
                  <legend>{t('messageCenter.staffChannels')}</legend>
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
                        {t('messageCenter.staffSuffix', { team: team.label })}
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
                          ? t('messageCenter.teamConversation')
                          : t('messageCenter.directMessage'))}
                    </span>
                    <small>
                      {conversation.guardianCopied
                        ? t('messageCenter.guardianIncluded')
                        : conversation.kind === 'team_staff'
                          ? t('messageCenter.staffChannel')
                          : conversation.kind === 'team'
                            ? t('messageCenter.teamConversation')
                            : t('messageCenter.directMessage')}
                      {conversation.unreadCount
                        ? ` · ${t('messageCenter.unread', { count: conversation.unreadCount })}`
                        : ''}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : teams.length ? (
            <p>{t('messageCenter.chooseTeam')}</p>
          ) : (
            <p>{t('messageCenter.noConversations')}</p>
          )}
        </Card>
        <section
          className="portal-chat-thread"
          aria-label={t('messageCenter.conversation')}
        >
          {activeConversation ? (
            <Card>
              <div className="portal-thread-heading">
                <h2>
                  {conversations.find((item) => item.id === activeConversation)
                    ?.title || t('messageCenter.conversation')}
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
                            ? t('messageCenter.conversationUnmuted')
                            : t('messageCenter.conversationMuted'),
                        );
                      })
                      .catch((cause: unknown) => {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : t('messageCenter.muteUpdateFailed'),
                        );
                      });
                  }}
                >
                  {conversations.find((item) => item.id === activeConversation)
                    ?.muted
                    ? t('messageCenter.unmute')
                    : t('messageCenter.mute')}
                </Button>
              </div>
              <ol className="portal-message-list" aria-live="polite">
                {messages.map((message) => (
                  <li key={message.id}>
                    <article>
                      <header>
                        <strong>{message.authorName}</strong>
                        <time dateTime={message.createdAt}>
                          {new Date(message.createdAt).toLocaleString(
                            i18n.resolvedLanguage,
                          )}
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
                                  {t('messageCenter.downloadAttachment', {
                                    mime: attachment.mime,
                                  })}
                                </Button>
                              ) : (
                                <span>
                                  {t('messageCenter.attachmentUnavailable')}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {message.deletedAt ? (
                        <p className="portal-removed">
                          {t('messageCenter.messageRemoved')}
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
                            {t('messageCenter.report')}
                          </Button>
                          {message.authorAccountId === accountId && (
                            <Button
                              type="button"
                              secondary
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t('messageCenter.hideConfirmation'),
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
                                          : t('messageCenter.hideFailed'),
                                      );
                                    });
                              }}
                            >
                              {t('messageCenter.hide')}
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
                          <Field label={t('messageCenter.reportReason')}>
                            <Select
                              value={reportReason}
                              onChange={(event) => {
                                setReportReason(event.target.value);
                              }}
                              options={[
                                {
                                  value: 'safesport_concern',
                                  label: t('messageCenter.safeSportConcern'),
                                },
                                {
                                  value: 'harassment',
                                  label: t('messageCenter.harassment'),
                                },
                                {
                                  value: 'inappropriate_content',
                                  label: t(
                                    'messageCenter.inappropriateContent',
                                  ),
                                },
                                {
                                  value: 'other',
                                  label: t('messageCenter.other'),
                                },
                              ]}
                            />
                          </Field>
                          <Field label={t('messageCenter.detailsOptional')}>
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
                            {t('messageCenter.sendReport')}
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
                <Field label={t('messageCenter.writeMessage')}>
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
                      label={t('messageCenter.attachImagePdf')}
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onFiles={(files) => {
                        const file = files?.[0];
                        if (file) void uploadFile(file);
                      }}
                    />
                  )}
                  {attachmentIds.length > 0 && (
                    <span>
                      {t('messageCenter.attachmentReady', {
                        count: attachmentIds.length,
                      })}
                    </span>
                  )}
                  <Button
                    disabled={
                      busy || (!body.trim() && attachmentIds.length === 0)
                    }
                    type="submit"
                  >
                    {t('messageCenter.sendMessage')}
                  </Button>
                </div>
              </form>
            </Card>
          ) : (
            <Card className="portal-empty-thread">
              <h2>{t('messageCenter.chooseConversation')}</h2>
              <p>{t('messageCenter.guardianExplanation')}</p>
            </Card>
          )}
        </section>
      </div>
      <Card>
        <h2>{t('messageCenter.smsConsent')}</h2>
        {smsConsent?.phoneE164 ? (
          <>
            <p>
              {t('messageCenter.phoneOnFile')}{' '}
              <strong>{smsConsent.phoneE164}</strong>
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
                ? t('messageCenter.turnOffSms')
                : t('messageCenter.enableSms')}
            </Button>
          </>
        ) : (
          <p>{t('messageCenter.verifiedPhoneRequired')}</p>
        )}
      </Card>
    </main>
  );
}
