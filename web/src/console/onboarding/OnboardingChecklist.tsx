import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { apiPost } from '../../api/client';
import { Badge, Button, Card } from '../../ui/primitives';
import { apiGetOrg, orgHeaders } from '../help/api';
import { onboardingChecklistSchema } from '../help/schemas';

export function OnboardingChecklist({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const checklist = useQuery({
    queryKey: ['onboarding', orgId],
    queryFn: () =>
      apiGetOrg('/onboarding/checklist', onboardingChecklistSchema, orgId),
    enabled: Boolean(orgId),
  });
  const dismiss = useMutation({
    mutationFn: (key: string) =>
      apiPost(
        `/onboarding/checklist/${key}/dismiss`,
        {},
        z.union([z.null(), z.object({})]),
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ['onboarding', orgId],
      }),
  });
  const dismissAll = useMutation({
    mutationFn: () =>
      apiPost(
        '/onboarding/checklist/dismiss-all',
        {},
        z.union([z.null(), z.object({})]),
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ['onboarding', orgId],
      }),
  });
  const restore = useMutation({
    mutationFn: (key: string) =>
      apiPost(
        `/onboarding/checklist/${key}/restore`,
        {},
        z.union([z.null(), z.object({})]),
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ['onboarding', orgId],
      }),
  });

  if (checklist.isPending) {
    return (
      <Card>
        <p role="status">Loading your setup checklist…</p>
      </Card>
    );
  }
  if (checklist.isError) {
    return (
      <Card>
        <p role="alert">Your setup progress is unavailable right now.</p>
        <Button
          secondary
          onClick={() => {
            void checklist.refetch();
          }}
        >
          Retry
        </Button>
      </Card>
    );
  }

  const items = checklist.data.items;
  const visible = checklist.data.items.filter(
    (item) => item.state !== 'dismissed',
  );
  const dismissed = items.filter((item) => item.state === 'dismissed');
  const done = items.filter((item) => item.state === 'complete').length;
  const hasMutationError =
    dismiss.isError || dismissAll.isError || restore.isError;
  return (
    <Card>
      <div className="onboarding-header">
        <h2>Set up your organization</h2>
        <Badge>
          {done}/{items.length} done
        </Badge>
      </div>
      {visible.length > 0 ? (
        <ul className="onboarding-list">
          {visible.map((item) => (
            <li key={item.key} className={`onboarding-item ${item.state}`}>
              <button
                type="button"
                className="onboarding-item-main"
                onClick={() => void navigate(item.href)}
              >
                <span className="onboarding-item-label">
                  {item.state === 'complete' ? '✓ ' : ''}
                  {item.label}
                </span>
                <span className="onboarding-item-description">
                  {item.description}
                </span>
              </button>
              {item.state === 'pending' && (
                <button
                  type="button"
                  className="onboarding-dismiss"
                  aria-label={`Dismiss ${item.label}`}
                  disabled={dismiss.isPending || dismissAll.isPending}
                  onClick={() => {
                    dismiss.mutate(item.key);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p role="status">
          {items.length === 0
            ? 'No setup steps are available yet.'
            : 'All setup steps are hidden. Restore a step below to continue.'}
        </p>
      )}

      {dismissed.length > 0 && (
        <details className="onboarding-dismissed" open={visible.length === 0}>
          <summary>Dismissed steps ({dismissed.length})</summary>
          <ul className="onboarding-list">
            {dismissed.map((item) => (
              <li key={item.key} className="onboarding-item dismissed">
                <div className="onboarding-item-main">
                  <span className="onboarding-item-label">{item.label}</span>
                  <span className="onboarding-item-description">
                    {item.description}
                  </span>
                </div>
                <Button
                  secondary
                  aria-label={`Restore ${item.label}`}
                  disabled={restore.isPending || dismissAll.isPending}
                  onClick={() => {
                    restore.mutate(item.key);
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {hasMutationError && (
        <p role="alert" className="onboarding-error">
          We couldn’t update your setup checklist. Please try again.
        </p>
      )}
      {visible.some((item) => item.state === 'pending') && (
        <Button
          secondary
          onClick={() => {
            dismissAll.mutate();
          }}
          disabled={dismissAll.isPending}
        >
          Dismiss checklist
        </Button>
      )}
    </Card>
  );
}
