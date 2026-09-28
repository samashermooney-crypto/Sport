import { recurrenceSchema } from '@shared/recurrence';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiDelete, apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from '../../ui/primitives';

import '../programs/programs.css';

const facilityRow = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  ownership: z.string(),
  public: z.boolean(),
  version: z.number().int().positive(),
  address: z.record(z.string(), z.string()).nullable(),
  timezone: z.string().nullable(),
  parking_notes: z.string().nullable(),
  map_url: z.string().nullable(),
});
const spaceRow = z.looseObject({
  id: z.uuid(),
  facility_id: z.uuid(),
  parent_space_id: z.uuid().nullable(),
  name: z.string(),
  kind: z.string(),
  surface: z.string().nullable(),
  has_lights: z.boolean(),
  suitability: z.record(z.string(), z.unknown()),
  capacity_people: z.number().nullable(),
  version: z.number().int().positive(),
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
  version: z.number().int().positive(),
  source: z.enum(['owned', 'permit']).optional(),
  permit_reference: z.string().nullable().optional(),
  cost_per_hour_cents: z.number().nullable().optional(),
});
const blackoutRow = z.looseObject({
  id: z.uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  reason: z.string(),
});
const textList = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .join(', ')
    : '';
const numberText = (value: unknown) =>
  typeof value === 'number' ? String(value) : '';
const splitList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const optionalNumber = (value: string) => (value.trim() ? Number(value) : null);

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
  const [surface, setSurface] = useState('');
  const [hasLights, setHasLights] = useState(false);
  const [capacityPeople, setCapacityPeople] = useState('');
  const [sportProfileIds, setSportProfileIds] = useState('');
  const [ageLabels, setAgeLabels] = useState('');
  const [minimumFieldSize, setMinimumFieldSize] = useState('');
  const [maximumFieldSize, setMaximumFieldSize] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [preset, setPreset] = useState('weekdays');
  const [editAvailabilityId, setEditAvailabilityId] = useState('');
  const [editAvailabilityVersion, setEditAvailabilityVersion] = useState(0);
  const [editRecurrence, setEditRecurrence] = useState<z.output<
    typeof recurrenceSchema
  > | null>(null);
  const [availabilitySource, setAvailabilitySource] = useState<
    'owned' | 'permit'
  >('owned');
  const [permitReference, setPermitReference] = useState('');
  const [costPerHourCents, setCostPerHourCents] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [startTime, setStartTime] = useState('17:00');
  const [endTime, setEndTime] = useState('21:00');
  const [blackoutStart, setBlackoutStart] = useState('');
  const [blackoutEnd, setBlackoutEnd] = useState('');
  const [blackoutReason, setBlackoutReason] = useState('');
  const [editFacility, setEditFacility] = useState<z.output<
    typeof facilityRow
  > | null>(null);
  const [editSpace, setEditSpace] = useState<z.output<typeof spaceRow> | null>(
    null,
  );
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
              {facility.public ? 'Public' : 'Private'}{' '}
              {facility.map_url && (
                <a href={facility.map_url} target="_blank" rel="noreferrer">
                  Map
                </a>
              )}{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  setEditFacility({ ...facility });
                }}
              >
                Edit
              </Button>{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  void mutate(async () => {
                    await apiPost(
                      `/facilities/orgs/${orgId}/${facility.id}/archive`,
                      { expectedVersion: facility.version },
                      facilityRow,
                    );
                    setNotice('Facility and its spaces archived');
                  });
                }}
              >
                Archive
              </Button>
            </li>
          ))}
        </ul>
        {editFacility && (
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                await apiPatch(
                  `/facilities/orgs/${orgId}/${editFacility.id}`,
                  {
                    expectedVersion: editFacility.version,
                    facility: {
                      name: editFacility.name,
                      ownership: editFacility.ownership,
                      address: editFacility.address,
                      timezone: editFacility.timezone,
                      parkingNotes: editFacility.parking_notes,
                      mapUrl: editFacility.map_url,
                      public: editFacility.public,
                    },
                  },
                  facilityRow,
                );
                setEditFacility(null);
                setNotice('Facility updated');
              });
            }}
          >
            <Field label="Facility name">
              <Input
                value={editFacility.name}
                onChange={(event) => {
                  setEditFacility({
                    ...editFacility,
                    name: event.target.value,
                  });
                }}
                required
              />
            </Field>
            <Field label="Ownership">
              <Select
                value={editFacility.ownership}
                onChange={(event) => {
                  setEditFacility({
                    ...editFacility,
                    ownership: event.target.value,
                  });
                }}
                options={['owned', 'permitted', 'partner']}
              />
            </Field>
            <fieldset>
              <legend>Address</legend>
              {(
                [
                  'line1',
                  'line2',
                  'city',
                  'region',
                  'postalCode',
                  'country',
                ] as const
              ).map((key) => (
                <Field
                  key={key}
                  label={key.replace(
                    /[A-Z]/g,
                    (letter) => ` ${letter.toLowerCase()}`,
                  )}
                >
                  <Input
                    value={editFacility.address?.[key] ?? ''}
                    onChange={(event) => {
                      setEditFacility({
                        ...editFacility,
                        address: {
                          ...editFacility.address,
                          [key]: event.target.value,
                        },
                      });
                    }}
                  />
                </Field>
              ))}
            </fieldset>
            <Field
              label="Timezone"
              hint="IANA time zone, such as America/Chicago"
            >
              <Input
                value={editFacility.timezone ?? ''}
                onChange={(event) => {
                  setEditFacility({
                    ...editFacility,
                    timezone: event.target.value || null,
                  });
                }}
              />
            </Field>
            <Field label="Parking notes">
              <Textarea
                value={editFacility.parking_notes ?? ''}
                onChange={(event) => {
                  setEditFacility({
                    ...editFacility,
                    parking_notes: event.target.value || null,
                  });
                }}
              />
            </Field>
            <Field label="Map link" hint="Use an https:// or http:// URL">
              <Input
                type="url"
                value={editFacility.map_url ?? ''}
                onChange={(event) => {
                  setEditFacility({
                    ...editFacility,
                    map_url: event.target.value || null,
                  });
                }}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={editFacility.public}
                onChange={(event) => {
                  setEditFacility({
                    ...editFacility,
                    public: event.target.checked,
                  });
                }}
              />{' '}
              Show on public site
            </label>
            <Button disabled={busy}>Save facility</Button>{' '}
            <Button
              type="button"
              secondary
              onClick={() => {
                setEditFacility(null);
              }}
            >
              Cancel
            </Button>
          </form>
        )}
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
              {space.name} · {space.kind} · {space.surface ?? 'Surface not set'}
              {space.has_lights ? ' · Lights' : ''}
              {space.capacity_people === null
                ? ''
                : ` · capacity ${String(space.capacity_people)}`}
              {space.parent_space_id ? ' · half/child' : ''}{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  setEditSpace({ ...space });
                }}
              >
                Edit
              </Button>{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  void mutate(async () => {
                    await apiPost(
                      `/facilities/orgs/${orgId}/spaces/${space.id}/archive`,
                      { expectedVersion: space.version },
                      spaceRow,
                    );
                    setNotice('Space archived');
                  });
                }}
              >
                Archive
              </Button>
            </li>
          ))}
        </ul>
        {editSpace && (
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                await apiPatch(
                  `/facilities/orgs/${orgId}/spaces/${editSpace.id}`,
                  {
                    expectedVersion: editSpace.version,
                    name: editSpace.name,
                    kind: editSpace.kind,
                    parentSpaceId: editSpace.parent_space_id,
                    surface: editSpace.surface,
                    hasLights: editSpace.has_lights,
                    capacityPeople: editSpace.capacity_people,
                    suitability: editSpace.suitability,
                  },
                  spaceRow,
                );
                setEditSpace(null);
                setNotice('Space updated');
              });
            }}
          >
            <Field label="Space name">
              <Input
                value={editSpace.name}
                onChange={(event) => {
                  setEditSpace({ ...editSpace, name: event.target.value });
                }}
                required
              />
            </Field>
            <Field label="Kind">
              <Select
                value={editSpace.kind}
                onChange={(event) => {
                  setEditSpace({ ...editSpace, kind: event.target.value });
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
            <Field label="Surface">
              <Input
                value={editSpace.surface ?? ''}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    surface: event.target.value || null,
                  });
                }}
              />
            </Field>
            <Field label="Capacity">
              <Input
                type="number"
                min="0"
                value={editSpace.capacity_people ?? ''}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    capacity_people: optionalNumber(event.target.value),
                  });
                }}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={editSpace.has_lights}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    has_lights: event.target.checked,
                  });
                }}
              />{' '}
              Lighting available
            </label>
            <Field
              label="Suitable sports"
              hint="Comma-separated sport profile IDs"
            >
              <Input
                value={textList(editSpace.suitability.sportProfileIds)}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    suitability: {
                      ...editSpace.suitability,
                      sportProfileIds: splitList(event.target.value),
                    },
                  });
                }}
              />
            </Field>
            <Field
              label="Suitable age groups"
              hint="Comma-separated labels, such as U10, U12"
            >
              <Input
                value={textList(editSpace.suitability.ageLabels)}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    suitability: {
                      ...editSpace.suitability,
                      ageLabels: splitList(event.target.value),
                    },
                  });
                }}
              />
            </Field>
            <Field label="Minimum field size">
              <Input
                type="number"
                min="0"
                value={numberText(editSpace.suitability.minimumFieldSize)}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    suitability: {
                      ...editSpace.suitability,
                      minimumFieldSize: optionalNumber(event.target.value),
                    },
                  });
                }}
              />
            </Field>
            <Field label="Maximum field size">
              <Input
                type="number"
                min="0"
                value={numberText(editSpace.suitability.maximumFieldSize)}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    suitability: {
                      ...editSpace.suitability,
                      maximumFieldSize: optionalNumber(event.target.value),
                    },
                  });
                }}
              />
            </Field>
            <Field label="Parent space">
              <Select
                value={editSpace.parent_space_id ?? ''}
                onChange={(event) => {
                  setEditSpace({
                    ...editSpace,
                    parent_space_id: event.target.value || null,
                  });
                }}
              >
                <option value="">Full space</option>
                {spaces
                  .filter(
                    (space) =>
                      space.id !== editSpace.id &&
                      space.facility_id === editSpace.facility_id,
                  )
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button disabled={busy}>Save space</Button>{' '}
            <Button
              type="button"
              secondary
              onClick={() => {
                setEditSpace(null);
              }}
            >
              Cancel
            </Button>
          </form>
        )}
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
                  surface: surface || null,
                  hasLights,
                  capacityPeople: optionalNumber(capacityPeople),
                  suitability: {
                    sportProfileIds: splitList(sportProfileIds),
                    ageLabels: splitList(ageLabels),
                    minimumFieldSize: optionalNumber(minimumFieldSize),
                    maximumFieldSize: optionalNumber(maximumFieldSize),
                  },
                },
                spaceRow,
              );
              setSpaceId(created.id);
              setSpaceName('');
              setSurface('');
              setHasLights(false);
              setCapacityPeople('');
              setSportProfileIds('');
              setAgeLabels('');
              setMinimumFieldSize('');
              setMaximumFieldSize('');
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
          <Field label="Surface">
            <Input
              value={surface}
              onChange={(event) => {
                setSurface(event.target.value);
              }}
            />
          </Field>
          <Field label="Capacity">
            <Input
              type="number"
              min="0"
              value={capacityPeople}
              onChange={(event) => {
                setCapacityPeople(event.target.value);
              }}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={hasLights}
              onChange={(event) => {
                setHasLights(event.target.checked);
              }}
            />{' '}
            Lighting available
          </label>
          <Field
            label="Suitable sports"
            hint="Comma-separated sport profile IDs"
          >
            <Input
              value={sportProfileIds}
              onChange={(event) => {
                setSportProfileIds(event.target.value);
              }}
            />
          </Field>
          <Field
            label="Suitable age groups"
            hint="Comma-separated labels, such as U10, U12"
          >
            <Input
              value={ageLabels}
              onChange={(event) => {
                setAgeLabels(event.target.value);
              }}
            />
          </Field>
          <Field label="Minimum field size">
            <Input
              type="number"
              min="0"
              value={minimumFieldSize}
              onChange={(event) => {
                setMinimumFieldSize(event.target.value);
              }}
            />
          </Field>
          <Field label="Maximum field size">
            <Input
              type="number"
              min="0"
              value={maximumFieldSize}
              onChange={(event) => {
                setMaximumFieldSize(event.target.value);
              }}
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
                : 'Recurring'}{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  void mutate(async () => {
                    await apiDelete(
                      `/facilities/orgs/${orgId}/availability/${window.id}`,
                      z.looseObject({ id: z.uuid() }),
                      { expectedVersion: window.version },
                    );
                    setNotice('Availability removed');
                  });
                }}
              >
                Remove
              </Button>
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  const recurrence = recurrenceSchema.parse(window.recurrence);
                  setSpaceId(window.space_id);
                  setEditAvailabilityId(window.id);
                  setEditAvailabilityVersion(window.version);
                  setEditRecurrence(recurrence);
                  if (recurrence.kind !== 'once') {
                    setStartsOn(recurrence.startsOn);
                    setEndsOn(recurrence.endsOn ?? '');
                  }
                  if (recurrence.kind === 'weekly') {
                    const byDay = recurrence.byDay.join(',');
                    setPreset(
                      byDay === 'MO,TU,WE,TH,FR'
                        ? 'weekdays'
                        : byDay === 'SA'
                          ? 'saturdays'
                          : 'custom',
                    );
                  } else {
                    setPreset('custom');
                  }
                  setStartTime(window.start_time.slice(0, 5));
                  setEndTime(window.end_time.slice(0, 5));
                  setAvailabilitySource(window.source ?? 'owned');
                  setPermitReference(window.permit_reference ?? '');
                  setCostPerHourCents(
                    window.cost_per_hour_cents === null ||
                      window.cost_per_hour_cents === undefined
                      ? ''
                      : String(window.cost_per_hour_cents),
                  );
                }}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const byDay =
                preset === 'weekdays'
                  ? ['MO', 'TU', 'WE', 'TH', 'FR']
                  : preset === 'saturdays'
                    ? ['SA']
                    : null;
              const recurrence =
                editRecurrence?.kind === 'monthly_nth_weekday'
                  ? editRecurrence
                  : editRecurrence?.kind === 'weekly'
                    ? {
                        ...editRecurrence,
                        ...(byDay ? { byDay } : {}),
                        startsOn,
                        endsOn: endsOn || null,
                      }
                    : {
                        kind: 'weekly' as const,
                        interval: 1 as const,
                        byDay: byDay ?? ['MO', 'TU', 'WE', 'TH', 'FR'],
                        startsOn,
                        endsOn: endsOn || null,
                        exceptions: [],
                        additions: [],
                      };
              if (editAvailabilityId) {
                await apiPatch(
                  `/facilities/orgs/${orgId}/availability/${editAvailabilityId}`,
                  {
                    expectedVersion: editAvailabilityVersion,
                    recurrence,
                    startTime,
                    endTime,
                    source: availabilitySource,
                    permitReference: permitReference || null,
                    costPerHourCents: optionalNumber(costPerHourCents),
                  },
                  availabilityRow,
                );
              } else {
                await apiPost(
                  `/facilities/orgs/${orgId}/availability`,
                  {
                    spaceId,
                    recurrence,
                    startTime,
                    endTime,
                    source: availabilitySource,
                    permitReference: permitReference || null,
                    costPerHourCents: optionalNumber(costPerHourCents),
                  },
                  availabilityRow,
                );
              }
              setEditAvailabilityId('');
              setEditRecurrence(null);
              setNotice(
                editAvailabilityId
                  ? 'Availability updated'
                  : 'Availability saved',
              );
            });
          }}
        >
          <Field label="Space">
            <Select
              value={spaceId}
              disabled={Boolean(editAvailabilityId)}
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
              disabled={editRecurrence?.kind === 'monthly_nth_weekday'}
              onChange={(event) => {
                setPreset(event.target.value);
                if (event.target.value === 'saturdays') {
                  setStartTime('08:00');
                  setEndTime('18:00');
                } else if (event.target.value === 'weekdays') {
                  setStartTime('17:00');
                  setEndTime('21:00');
                }
              }}
              options={[
                { value: 'weekdays', label: 'Weekdays 5–9pm' },
                { value: 'saturdays', label: 'Saturdays 8am–6pm' },
              ]}
            >
              {editRecurrence && (
                <option value="custom">Custom recurrence</option>
              )}
            </Select>
          </Field>
          <Field label="From date">
            <Input
              type="date"
              disabled={editRecurrence?.kind === 'monthly_nth_weekday'}
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
              disabled={editRecurrence?.kind === 'monthly_nth_weekday'}
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
          <Field label="Availability source">
            <Select
              value={availabilitySource}
              onChange={(event) => {
                setAvailabilitySource(event.target.value as 'owned' | 'permit');
              }}
              options={[
                { value: 'owned', label: 'Owned' },
                { value: 'permit', label: 'Permitted' },
              ]}
            />
          </Field>
          {availabilitySource === 'permit' && (
            <>
              <Field label="Permit reference">
                <Input
                  value={permitReference}
                  onChange={(event) => {
                    setPermitReference(event.target.value);
                  }}
                />
              </Field>
              <Field label="Cost per hour in cents">
                <Input
                  type="number"
                  min="0"
                  value={costPerHourCents}
                  onChange={(event) => {
                    setCostPerHourCents(event.target.value);
                  }}
                />
              </Field>
            </>
          )}
          <Button disabled={busy || !spaceId}>
            {editAvailabilityId
              ? 'Save availability changes'
              : 'Save availability'}
          </Button>
          {editAvailabilityId && (
            <Button
              type="button"
              secondary
              onClick={() => {
                setEditAvailabilityId('');
                setEditRecurrence(null);
              }}
            >
              Cancel edit
            </Button>
          )}
        </form>
      </Card>
      <Card>
        <h2>Blackouts</h2>
        <ul>
          {blackouts.map((blackout) => (
            <li key={blackout.id}>
              {blackout.reason} ·{' '}
              {new Date(blackout.starts_at).toLocaleString()}–
              {new Date(blackout.ends_at).toLocaleString()}{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  void mutate(async () => {
                    await apiDelete(
                      `/facilities/orgs/${orgId}/blackouts/${blackout.id}`,
                      z.looseObject({ id: z.uuid() }),
                    );
                    setNotice('Blackout removed');
                  });
                }}
              >
                Remove
              </Button>
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
