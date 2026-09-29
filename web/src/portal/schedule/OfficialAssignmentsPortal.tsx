import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Badge, Button, PageHeader } from '../../ui';
import { PortalShell } from '../PortalShell';

import '../../console/schedule/schedule.css';

const assignmentSchema = z.strictObject({
  id: z.uuid(),
  contest_id: z.uuid(),
  position_key: z.string(),
  status: z.string(),
  version: z.number().int().positive(),
  fee_cents: z.number().int().nonnegative(),
  mileage_cents: z.number().int().nonnegative(),
  title: z.string(),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  timezone: z.string(),
  location_text: z.string().nullable(),
});

const assignmentsSchema = z.strictObject({
  items: z.array(assignmentSchema),
});

const responseSchema = z.unknown();

type Assignment = z.infer<typeof assignmentSchema>;

export function OfficialAssignmentsPortal({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [items, setItems] = useState<Assignment[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await apiGet(
        `/officials/orgs/${encodeURIComponent(orgId)}/me/assignments`,
        assignmentsSchema,
      );
      setItems(result.items);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Your officiating schedule could not be loaded.',
      );
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function respond(
    assignment: Assignment,
    response: 'accepted' | 'declined',
  ): Promise<void> {
    setBusyId(assignment.id);
    setError('');
    setMessage('');
    try {
      await apiPost(
        `/officials/orgs/${encodeURIComponent(orgId)}/assignments/${encodeURIComponent(assignment.id)}/respond`,
        { expectedVersion: assignment.version, response },
        responseSchema,
      );
      setMessage(
        response === 'accepted'
          ? 'Assignment accepted.'
          : 'Assignment declined.',
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Your assignment response could not be saved.',
      );
    } finally {
      setBusyId('');
    }
  }

  return (
    <PortalShell orgId={orgId}>
      <main className="schedule-page">
        <PageHeader
          kicker="OFFICIAL PORTAL"
          title="My officiating schedule"
          description="Review game details and respond to assignment offers."
        />
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {!error && !items.length && (
          <section className="schedule-card">
            <p>No current officiating assignments.</p>
          </section>
        )}
        {items.map((assignment) => (
          <article className="schedule-card" key={assignment.id}>
            <div className="schedule-card__title">
              <h2>{assignment.title}</h2>
              <Badge
                tone={
                  ['accepted', 'confirmed'].includes(assignment.status)
                    ? 'ok'
                    : 'pending'
                }
              >
                {assignment.status}
              </Badge>
            </div>
            <p>
              {assignment.position_key} ·{' '}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'full',
                timeStyle: 'short',
                timeZone: assignment.timezone,
              }).format(new Date(assignment.starts_at))}
            </p>
            <p>
              {assignment.location_text ?? 'Location to be announced'} ·{' '}
              {assignment.timezone}
            </p>
            {assignment.status === 'offered' && (
              <div className="schedule-actions">
                <Button
                  disabled={Boolean(busyId)}
                  onClick={() => void respond(assignment, 'accepted')}
                >
                  Accept assignment
                </Button>
                <Button
                  secondary
                  disabled={Boolean(busyId)}
                  onClick={() => void respond(assignment, 'declined')}
                >
                  Decline assignment
                </Button>
              </div>
            )}
          </article>
        ))}
      </main>
    </PortalShell>
  );
}
