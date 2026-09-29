import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import {
  websiteContactReadResponseSchema,
  websiteContactSubmissionListSchema,
} from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { apiGet } from '../../api/client';
import { Button, Card, PageHeader } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';

async function markAllRead(orgId: string): Promise<number> {
  const response = await fetch(
    `/api/v1/website/orgs/${orgId}/contact-submissions/mark-read`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: '{}',
    },
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error('Contact submissions could not be marked as read.');
  return websiteContactReadResponseSchema.parse(value).updatedCount;
}

export function WebsiteContactsConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
  });
  const submissions = useQuery({
    queryKey: ['orgs', orgId, 'website-contact-submissions'],
    queryFn: () =>
      apiGet(
        `/website/orgs/${orgId}/contact-submissions`,
        websiteContactSubmissionListSchema,
      ),
  });
  const mutation = useMutation({
    mutationFn: () => markAllRead(orgId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['orgs', orgId, 'website-contact-submissions'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['orgs', orgId, 'action-center'],
        }),
      ]);
    },
  });

  if (workspace.isPending || submissions.isPending)
    return <p role="status">{t('websiteContacts.loading')}</p>;
  if (workspace.isError || submissions.isError)
    return <main role="alert">{t('websiteContacts.unavailable')}</main>;

  const unreadCount = submissions.data.items.filter(
    (item) => item.status === 'new',
  ).length;
  const homePath = `/console/orgs/${orgId}`;
  const websitePath = `${homePath}/website`;
  return (
    <AppShell
      orgName={workspace.data.name}
      navigation={[
        {
          label: t('websiteContacts.manage'),
          items: [
            { label: t('websiteContacts.home'), to: homePath },
            { label: t('websiteContacts.website'), to: websitePath },
            {
              label: t('websiteContacts.contactInbox'),
              to: `${websitePath}/contacts`,
              current: true,
            },
            { label: t('websiteContacts.account'), to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: t('websiteContacts.home'), to: homePath },
        { label: t('websiteContacts.website'), to: websitePath },
        { label: t('websiteContacts.account'), to: '/me' },
      ]}
    >
      <main className="page-content website-contact-inbox">
        <PageHeader
          kicker={t('websiteContacts.kicker')}
          title={t('websiteContacts.title')}
          description={t('websiteContacts.description')}
        />
        <div className="website-contact-inbox__actions">
          <p aria-live="polite">
            {t('websiteContacts.unreadCount', { count: unreadCount })}
          </p>
          <Button
            type="button"
            secondary
            disabled={unreadCount === 0 || mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {mutation.isPending
              ? t('websiteContacts.markingRead')
              : t('websiteContacts.markAllRead')}
          </Button>
        </div>
        {mutation.isError ? (
          <p role="alert">{t('websiteContacts.markReadFailed')}</p>
        ) : mutation.isSuccess ? (
          <p role="status">
            {t('websiteContacts.markedRead', { count: mutation.data })}
          </p>
        ) : null}
        {submissions.data.items.length === 0 ? (
          <Card>
            <h2>{t('websiteContacts.inboxEmpty')}</h2>
            <p>{t('websiteContacts.inboxEmptyDescription')}</p>
          </Card>
        ) : (
          <div className="website-contact-inbox__list">
            {submissions.data.items.map((item) => (
              <Card key={item.id}>
                <article aria-labelledby={`website-contact-${item.id}`}>
                  <div className="website-contact-inbox__heading">
                    <div>
                      <h2 id={`website-contact-${item.id}`}>
                        {item.subject || t('websiteContacts.messageFallback')}
                      </h2>
                      <p>
                        <a href={`mailto:${item.email}`}>{item.name}</a>
                        {' · '}
                        <time dateTime={item.createdAt}>
                          {new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(new Date(item.createdAt))}
                        </time>
                      </p>
                    </div>
                    <span>
                      {item.status === 'new'
                        ? t('websiteContacts.unread')
                        : item.status === 'read'
                          ? t('websiteContacts.read')
                          : t('websiteContacts.archived')}
                    </span>
                  </div>
                  <p className="website-contact-inbox__body">{item.body}</p>
                </article>
              </Card>
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}
