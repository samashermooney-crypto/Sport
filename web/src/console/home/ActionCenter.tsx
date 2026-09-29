import { websiteContactReadResponseSchema } from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { apiGet } from '../../api/client';
import { Button, Card, Link, PageHeader } from '../../ui/primitives';

import { actionCenterResponseSchema } from './action-center-schema';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

async function markWebsiteContactsRead(orgId: string): Promise<number> {
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

export function ActionCenter({ orgId }: { orgId: string }): React.JSX.Element {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();
  const markContactsMutation = useMutation({
    mutationFn: () => markWebsiteContactsRead(orgId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['orgs', orgId, 'action-center'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['orgs', orgId, 'website-contact-submissions'],
        }),
      ]);
    },
  });
  const actionCenter = useQuery({
    queryKey: ['orgs', orgId, 'action-center'],
    queryFn: () =>
      apiGet(
        `/action-center/orgs/${orgId}/action-center`,
        actionCenterResponseSchema,
      ),
  });

  if (actionCenter.isPending)
    return <p role="status">Loading the Action Center…</p>;
  if (actionCenter.isError)
    return <p role="alert">Operational queues are unavailable.</p>;

  return (
    <main className="console-home action-center">
      <PageHeader
        title="Action Center"
        kicker="ORGANIZATION HOME"
        description="Review the work that needs attention across your organization."
      />
      {markContactsMutation.isError ? (
        <p role="alert">{t('websiteContacts.markReadFailed')}</p>
      ) : markContactsMutation.isSuccess ? (
        <p role="status" aria-live="polite">
          {t('websiteContacts.markedRead', {
            count: markContactsMutation.data,
          })}
        </p>
      ) : null}
      {actionCenter.data.cards.length === 0 ? (
        <Card className="action-center__empty">
          <h2>Everything is up to date</h2>
          <p>No operational queues need attention for your role.</p>
        </Card>
      ) : (
        <div className="console-home__cards">
          {actionCenter.data.cards.map((card) => (
            <Card key={card.id} className="action-center__card">
              <div className="action-center__card-heading">
                <h2>{card.title}</h2>
                <strong aria-label={`${String(card.count)} items`}>
                  {card.count}
                </strong>
              </div>
              {card.amountCents !== undefined && (
                <p className="action-center__amount">
                  {formatMoney(card.amountCents)} outstanding
                </p>
              )}
              <ul>
                {card.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={item.href}
                      aria-label={`${item.label}: ${item.detail}`}
                    >
                      <span>{item.label}</span>
                      <span className="action-center__detail">
                        {item.detail}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link to={card.href}>
                {card.actionLabel} <span aria-hidden="true">→</span>
              </Link>
              {card.bulkAction === 'mark_contacts_read' ? (
                <>
                  <Button
                    type="button"
                    secondary
                    disabled={markContactsMutation.isPending}
                    onClick={() => {
                      markContactsMutation.mutate();
                    }}
                  >
                    {markContactsMutation.isPending
                      ? t('websiteContacts.markingRead')
                      : t('websiteContacts.markAllRead')}
                  </Button>
                </>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
