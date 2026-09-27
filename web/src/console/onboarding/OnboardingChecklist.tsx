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
}): React.JSX.Element | null {
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
  if (checklist.isPending || checklist.isError) return null;
  const visible = checklist.data.items.filter(
    (item) => item.state !== 'dismissed',
  );
  if (visible.length === 0) return null;
  const done = visible.filter((item) => item.state === 'complete').length;
  return (
    <Card>
      <div className="onboarding-header">
        <h2>Set up your organization</h2>
        <Badge>
          {done}/{visible.length} done
        </Badge>
      </div>
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
