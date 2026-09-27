import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, Field, Input, Select } from '../../ui/primitives';

import '../programs/programs.css';

const facilityRow = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  ownership: z.string(),
  public: z.boolean(),
  version: z.number().int().positive(),
});
const spaceRow = z.looseObject({
  id: z.uuid(),
  facility_id: z.uuid(),
  parent_space_id: z.uuid().nullable(),
  name: z.string(),
  kind: z.string(),
});
const listSchema = z.object({
  facilities: z.array(facilityRow),
  spaces: z.array(spaceRow),
});
const availabilityRow = z.looseObject({
  id: z.uuid(),
  space_id: z.uuid(),
  recurrence: z.unknown(),
  start_time: z.string(),
  end_time: z.string(),
});
const blackoutRow = z.looseObject({
  id: z.uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  reason: z.string(),
});

export function FacilitiesConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [facilities, setFacilities] = useState<z.output<typeof facilityRow>[]>(
    [],
  );
  const [spaces, setSpaces] = useState<z.output<typeof spaceRow>[]>([]);
  const [availability, setAvailability] = useState<
    z.output<typeof availabilityRow>[]
  >([]);
  const [blackouts, setBlackouts] = useState<z.output<typeof blackoutRow>[]>(
    [],
  );
  const [name, setName] = useState('');
  const [ownership, setOwnership] = useState('owned');
  const [facilityId, setFacilityId] = useState('');
  const [parentSpaceId, setParentSpaceId] = useState('');
  const [spaceName, setSpaceName] = useState('');
  const [kind, setKind] = useState('field');
  const [spaceId, setSpaceId] = useState('');
  const [preset, setPreset] = useState('weekdays');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [startTime, setStartTime] = useState('17:00');
  const [endTime, setEndTime] = useState('21:00');
  const [blackoutStart, setBlackoutStart] = useState('');
  const [blackoutEnd, setBlackoutEnd] = useState('');
  const [blackoutReason, setBlackoutReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [listing, closures] = await Promise.all([
      apiGet(`/facilities/orgs/${orgId}`, listSchema),
      apiGet(`/facilities/orgs/${orgId}/blackouts`, z.array(blackoutRow)),
    ]);
    setFacilities(listing.facilities);
    setSpaces(listing.spaces);
    setBlackouts(closures);
    setFacilityId((current) => current || listing.facilities[0]?.id || '');
    setSpaceId((current) => current || listing.spaces[0]?.id || '');
  }, [orgId]);
  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(
        cause instanceof Error ? cause.message : 'Facilities unavailable',
      );
    });
  }, [load]);
  useEffect(() => {
    if (!spaceId) return;
    void apiGet(
      `/facilities/orgs/${orgId}/spaces/${spaceId}/availability`,
      z.array(availabilityRow),
    )
      .then(setAvailability)
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : 'Availability unavailable',
        );
      });
  }, [orgId, spaceId]);
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      if (spaceId)
        setAvailability(
          await apiGet(
            `/facilities/orgs/${orgId}/spaces/${spaceId}/availability`,
            z.array(availabilityRow),
          ),
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save changes',
      );
    } finally {
      setBusy(false);
    }
  };
  const selectedSpaces = spaces.filter(
    (space) => space.facility_id === facilityId,
  );
  return (
    <div className="phase3-stack">
      {error && (
        <p role="alert" className="phase3-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="phase3-notice">
          {notice}
        </p>
      )}
      <Card>
        <h2>Facilities</h2>
        <ul>
          {facilities.map((facility) => (
            <li key={facility.id}>
              <strong>{facility.name}</strong> · {facility.ownership} ·{' '}
              {facility.public ? 'Public' : 'Private'}
            </li>
          ))}
        </ul>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const created = await apiPost(
                `/facilities/orgs/${orgId}`,
                { name, ownership, public: false },
                facilityRow,
              );
              setFacilityId(created.id);
              setName('');
              setNotice('Facility created');
            });
          }}
        >
          <Field label="Facility name">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Ownership">
            <Select
              value={ownership}
              onChange={(event) => {
                setOwnership(event.target.value);
              }}
              options={['owned', 'permitted', 'partner']}
            />
          </Field>
          <Button disabled={busy}>Create facility</Button>
        </form>
      </Card>
      <Card>
        <h2>Spaces and split fields</h2>
        <ul>
          {spaces.map((space) => (
            <li key={space.id}>
              {space.name} · {space.kind}
              {space.parent_space_id ? ' · half/child' : ''}
            </li>
          ))}
        </ul>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const created = await apiPost(
                `/facilities/orgs/${orgId}/spaces`,
                {
                  facilityId,
                  parentSpaceId: parentSpaceId || null,
                  name: spaceName,
                  kind,
                  suitability: {},
                },
                spaceRow,
              );
              setSpaceId(created.id);
              setSpaceName('');
              setNotice('Space created');
            });
          }}
        >
          <Field label="Facility">
            <Select
              value={facilityId}
              onChange={(event) => {
                setFacilityId(event.target.value);
                setParentSpaceId('');
              }}
            >
              <option value="">Choose facility</option>
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Parent space">
            <Select
              value={parentSpaceId}
              onChange={(event) => {
                setParentSpaceId(event.target.value);
              }}
            >
              <option value="">Full space</option>
              {selectedSpaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Space name">
            <Input
              value={spaceName}
              onChange={(event) => {
                setSpaceName(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
              }}
              options={[
                'field',
                'court',
                'rink',
                'pool',
                'lanes',
                'mat',
                'diamond',
                'track',
                'room',
                'other',
              ]}
            />
          </Field>
          <Button disabled={busy || !facilityId}>Create space</Button>
        </form>
      </Card>
      <Card>
        <h2>Availability</h2>
        <ul>
          {availability.map((window) => (
            <li key={window.id}>
              {window.start_time}–{window.end_time} ·{' '}
              {typeof window.recurrence === 'object' &&
              window.recurrence &&
              'kind' in window.recurrence
                ? String(window.recurrence.kind)
                : 'Recurring'}
            </li>
          ))}
        </ul>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const byDay =
                preset === 'weekdays' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : ['SA'];
              await apiPost(
                `/facilities/orgs/${orgId}/availability`,
                {
                  spaceId,
                  recurrence: {
                    kind: 'weekly',
                    interval: 1,
                    byDay,
                    startsOn,
                    endsOn: endsOn || null,
                    exceptions: [],
                    additions: [],
                  },
                  startTime,
                  endTime,
                  source: 'owned',
                },
                availabilityRow,
              );
              setNotice('Availability saved');
            });
          }}
        >
          <Field label="Space">
            <Select
              value={spaceId}
              onChange={(event) => {
                setSpaceId(event.target.value);
              }}
            >
              <option value="">Choose space</option>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Preset">
            <Select
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                if (event.target.value === 'saturdays') {
                  setStartTime('08:00');
                  setEndTime('18:00');
                } else {
                  setStartTime('17:00');
                  setEndTime('21:00');
                }
              }}
              options={[
                { value: 'weekdays', label: 'Weekdays 5–9pm' },
                { value: 'saturdays', label: 'Saturdays 8am–6pm' },
              ]}
            />
          </Field>
          <Field label="From date">
            <Input
              type="date"
              value={startsOn}
              onChange={(event) => {
                setStartsOn(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Through date">
            <Input
              type="date"
              value={endsOn}
              onChange={(event) => {
                setEndsOn(event.target.value);
              }}
            />
          </Field>
          <Field label="Start time">
            <Input
              type="time"
              value={startTime}
              onChange={(event) => {
                setStartTime(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="End time">
            <Input
              type="time"
              value={endTime}
              onChange={(event) => {
                setEndTime(event.target.value);
              }}
              required
            />
          </Field>
          <Button disabled={busy || !spaceId}>Save availability</Button>
        </form>
      </Card>
      <Card>
        <h2>Blackouts</h2>
        <ul>
          {blackouts.map((blackout) => (
            <li key={blackout.id}>
              {blackout.reason} ·{' '}
              {new Date(blackout.starts_at).toLocaleString()}–
              {new Date(blackout.ends_at).toLocaleString()}
            </li>
          ))}
        </ul>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              await apiPost(
                `/facilities/orgs/${orgId}/blackouts`,
                {
                  spaceId: spaceId || null,
                  facilityId: spaceId ? null : facilityId,
                  startsAt: new Date(blackoutStart).toISOString(),
                  endsAt: new Date(blackoutEnd).toISOString(),
                  reason: blackoutReason,
                },
                blackoutRow,
              );
              setBlackoutReason('');
              setNotice('Blackout saved');
            });
          }}
        >
          <Field label="Starts">
            <Input
              type="datetime-local"
              value={blackoutStart}
              onChange={(event) => {
                setBlackoutStart(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Ends">
            <Input
              type="datetime-local"
              value={blackoutEnd}
              onChange={(event) => {
                setBlackoutEnd(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Reason">
            <Input
              value={blackoutReason}
              onChange={(event) => {
                setBlackoutReason(event.target.value);
              }}
              required
            />
          </Field>
          <Button disabled={busy || (!spaceId && !facilityId)}>
            Add blackout
          </Button>
        </form>
      </Card>
    </div>
  );
}
