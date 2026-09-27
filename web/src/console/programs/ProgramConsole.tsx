import { orgLocalToInstant } from '@shared/dates';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import { Button, Card, Field, Input, Select } from '../../ui/primitives';

import { SeasonRollover } from './SeasonRollover';
import { SportProfileEditor } from './SportProfileEditor';

import './programs.css';

const row = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  version: z.number().int().positive(),
});
const seasonSchema = row.extend({
  starts_on: z.string(),
  ends_on: z.string(),
  status: z.string(),
});
const profileSchema = row.extend({
  profile: z.unknown(),
  template_key: z.string().nullable(),
  hasResults: z.boolean().optional(),
});
const templateSchema = z.object({
  key: z.string(),
  name: z.object({ en: z.string() }),
  category: z.string(),
  profile: z.unknown(),
});
const programSchema = row.extend({
  slug: z.string(),
  status: z.string(),
  season_id: z.uuid(),
});
const programDetailSchema = z.object({
  program: programSchema,
  divisions: z.array(
    z.looseObject({ id: z.uuid(), name: z.string(), is_default: z.boolean() }),
  ),
  offerings: z.array(row),
});
const installmentSchema = z.object({
  templates: z.array(
    z.looseObject({ id: z.uuid(), name: z.string(), active: z.boolean() }),
  ),
});
const pricingContextSchema = z.strictObject({ timezone: z.string() });
const librarySchema = z.object({
  forms: z.array(
    z.looseObject({
      id: z.uuid(),
      name: z.string(),
      scope: z.string(),
      version: z.number().int(),
    }),
  ),
  waivers: z.array(
    z.looseObject({
      id: z.uuid(),
      name: z.string(),
      requires: z.string(),
      renewal: z.string(),
      version: z.number().int(),
    }),
  ),
});
type Season = z.output<typeof seasonSchema>;
type Profile = z.output<typeof profileSchema>;
type Program = z.output<typeof programSchema>;
type Template = z.output<typeof templateSchema>;
type AddOnDraft = {
  name: string;
  price: string;
  required: boolean;
  options: string;
};

const modes = [
  'league',
  'club',
  'class',
  'camp',
  'clinic',
  'tryout',
  'tournament',
  'event',
  'membership',
];
type OfferingDraft = {
  name: string;
  price: string;
  capacity: string;
  installmentTemplateId: string;
  earlyPrice: string;
  earlyEndsAt: string;
  latePrice: string;
  lateStartsAt: string;
  siblingDiscountEligible: boolean;
  addOns: AddOnDraft[];
};
const emptyAddOn = (): AddOnDraft => ({
  name: '',
  price: '0',
  required: false,
  options: '',
});
const emptyOffering = (): OfferingDraft => ({
  name: 'Player registration',
  price: '0',
  capacity: '',
  installmentTemplateId: '',
  earlyPrice: '',
  earlyEndsAt: '',
  latePrice: '',
  lateStartsAt: '',
  siblingDiscountEligible: true,
  addOns: [],
});
const dollarsToCents = (value: string, label: string): number => {
  const amount = Number(value);
  if (!value.trim() || !Number.isFinite(amount) || amount < 0)
    throw new Error(`${label} must be zero or greater`);
  return Math.round(amount * 100);
};
const optionalDollarsToCents = (value: string, label: string) =>
  value.trim() ? dollarsToCents(value, label) : undefined;
const optionKey = (value: string, index: number) =>
  value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `choice-${String(index + 1)}`;
const dateTimeValue = (value: string, timezone: string) =>
  value ? orgLocalToInstant(value, timezone) : undefined;

export function ProgramConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [editSeason, setEditSeason] = useState<Season | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [plans, setPlans] = useState<
    z.output<typeof installmentSchema>['templates']
  >([]);
  const [orgTimezone, setOrgTimezone] = useState('UTC');
  const [programs, setPrograms] = useState<Program[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [seasonName, setSeasonName] = useState('');
  const [seasonStart, setSeasonStart] = useState('');
  const [seasonEnd, setSeasonEnd] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [editProfileId, setEditProfileId] = useState('');
  const [step, setStep] = useState(0);
  const [seasonId, setSeasonId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [mode, setMode] = useState('club');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [divisionMethod, setDivisionMethod] = useState<
    'none' | 'birth_year' | 'school_grade'
  >('none');
  const [divisionFrom, setDivisionFrom] = useState('6');
  const [divisionTo, setDivisionTo] = useState('14');
  const [boys, setBoys] = useState(true);
  const [girls, setGirls] = useState(true);
  const [coed, setCoed] = useState(false);
  const [offerings, setOfferings] = useState<OfferingDraft[]>([
    emptyOffering(),
  ]);
  const [formIds, setFormIds] = useState<string[]>([]);
  const [waiverIds, setWaiverIds] = useState<string[]>([]);
  const [libraries, setLibraries] = useState<z.output<typeof librarySchema>>({
    forms: [],
    waivers: [],
  });
  const [emergencyContact, setEmergencyContact] = useState(true);
  const [medicalSection, setMedicalSection] = useState(false);
  const [createdProgramId, setCreatedProgramId] = useState('');

  const load = useCallback(async () => {
    const [
      nextSeasons,
      nextProfiles,
      nextTemplates,
      nextPlans,
      nextPricingContext,
      nextPrograms,
      nextLibraries,
    ] = await Promise.all([
      apiGet(`/seasons/orgs/${orgId}`, z.array(seasonSchema)),
      apiGet(`/sports/orgs/${orgId}`, z.array(profileSchema)),
      apiGet('/sports/templates', z.array(templateSchema)),
      apiGet(
        `/offerings/orgs/${orgId}/installment-templates`,
        installmentSchema,
      ),
      apiGet(`/offerings/orgs/${orgId}/pricing-context`, pricingContextSchema),
      apiGet(`/programs/orgs/${orgId}`, z.array(programSchema)),
      apiGet(`/offerings/orgs/${orgId}/libraries`, librarySchema),
    ]);
    setSeasons(nextSeasons);
    setProfiles(nextProfiles);
    setTemplates(nextTemplates);
    setPlans(nextPlans.templates);
    setOrgTimezone(nextPricingContext.timezone);
    setPrograms(nextPrograms);
    setLibraries(nextLibraries);
    setSeasonId((current) => current || nextSeasons[0]?.id || '');
    setProfileId((current) => current || nextProfiles[0]?.id || '');
  }, [orgId]);
  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Programs unavailable');
    });
  }, [load]);
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save changes',
      );
    } finally {
      setBusy(false);
    }
  };
  const createSeason = () =>
    mutate(async () => {
      const created = await apiPost(
        `/seasons/orgs/${orgId}`,
        { name: seasonName, startsOn: seasonStart, endsOn: seasonEnd },
        seasonSchema,
      );
      setSeasonId(created.id);
      setSeasonName('');
      setNotice(`Created ${created.name}`);
    });
  const saveSeason = () =>
    mutate(async () => {
      if (!editSeason) return;
      await apiPatch(
        `/seasons/orgs/${orgId}/${editSeason.id}`,
        {
          expectedVersion: editSeason.version,
          name: editSeason.name,
          startsOn: editSeason.starts_on.slice(0, 10),
          endsOn: editSeason.ends_on.slice(0, 10),
          status: editSeason.status,
        },
        seasonSchema,
      );
      setEditSeason(null);
      setNotice('Season updated');
    });
  const cloneSport = () =>
    mutate(async () => {
      const created = await apiPost(
        `/sports/orgs/${orgId}`,
        { templateKey },
        profileSchema,
      );
      setProfileId(created.id);
      setNotice(`Added ${created.name}`);
    });
  const updateOffering = (index: number, patch: Partial<OfferingDraft>) => {
    setOfferings((current) =>
      current.map((offering, position) =>
        position === index ? { ...offering, ...patch } : offering,
      ),
    );
  };
  const updateAddOn = (
    offeringIndex: number,
    addOnIndex: number,
    patch: Partial<AddOnDraft>,
  ) => {
    setOfferings((current) =>
      current.map((offering, index) =>
        index === offeringIndex
          ? {
              ...offering,
              addOns: offering.addOns.map((addOn, at) =>
                at === addOnIndex ? { ...addOn, ...patch } : addOn,
              ),
            }
          : offering,
      ),
    );
  };
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const editedProfile = profiles.find(
    (profile) => profile.id === editProfileId,
  );
  const submitWizard = () =>
    mutate(async () => {
      if (!seasonId || !profileId)
        throw new Error('Create a season and add a sport before continuing');
      if (!name.trim() || !slug.trim())
        throw new Error('Add a program name and URL slug');
      if (!startsOn || !endsOn || endsOn < startsOn)
        throw new Error('Choose a valid start and end date');
      const genders = [
        boys ? 'boys' : '',
        girls ? 'girls' : '',
        coed ? 'coed' : '',
      ].filter(Boolean);
      if (divisionMethod !== 'none' && !genders.length)
        throw new Error('Choose at least one division category');
      let programId = createdProgramId;
      if (!programId) {
        const created = await apiPost(
          `/programs/orgs/${orgId}`,
          {
            seasonId,
            sportProfileId: profileId,
            mode,
            name,
            slug,
            startsOn,
            endsOn,
            visibility: 'public',
            settings: {
              requiredEmergencyContact: emergencyContact,
              requiredMedicalSection: medicalSection,
            },
          },
          programSchema,
        );
        programId = created.id;
        setCreatedProgramId(created.id);
      }
      // Retry-safe: only the steps that have not completed yet run again.
      const detail = await apiGet(
        `/programs/orgs/${orgId}/${programId}`,
        programDetailSchema,
      );
      if (
        divisionMethod !== 'none' &&
        !detail.divisions.some((division) => !division.is_default)
      ) {
        await apiPost(
          `/programs/orgs/${orgId}/${programId}/divisions/generate`,
          {
            method: divisionMethod,
            from: Number(divisionFrom),
            to: Number(divisionTo),
            genders,
          },
          z.array(row),
        );
      }
      for (const offering of offerings.slice(detail.offerings.length)) {
        const earlyPriceCents = optionalDollarsToCents(
          offering.earlyPrice,
          'Early price',
        );
        const earlyEndsAt = dateTimeValue(offering.earlyEndsAt, orgTimezone);
        const latePriceCents = optionalDollarsToCents(
          offering.latePrice,
          'Late price',
        );
        const lateStartsAt = dateTimeValue(offering.lateStartsAt, orgTimezone);
        if ((earlyPriceCents === undefined) !== (earlyEndsAt === undefined))
          throw new Error(
            'Complete both early price fields or leave them blank',
          );
        if ((latePriceCents === undefined) !== (lateStartsAt === undefined))
          throw new Error(
            'Complete both late price fields or leave them blank',
          );
        const addOns = offering.addOns.map((addOn, addOnIndex) => {
          const options = addOn.options
            .split(',')
            .map((option) => option.trim())
            .filter(Boolean)
            .map((label, optionIndex) => ({
              key: optionKey(label, optionIndex),
              label,
            }));
          if (
            new Set(options.map((option) => option.key)).size !== options.length
          )
            throw new Error(`Choices for ${addOn.name} must be unique`);
          if (!addOn.name.trim()) throw new Error('Name every offered product');
          return {
            key: `add-on-${String(addOnIndex + 1)}`,
            name: addOn.name.trim(),
            priceCents: dollarsToCents(addOn.price, `${addOn.name} price`),
            required: addOn.required,
            options,
          };
        });
        await apiPost(
          `/offerings/orgs/${orgId}`,
          {
            programId,
            name: offering.name,
            registrantRole: 'athlete',
            priceCents: dollarsToCents(offering.price, 'Offering price'),
            capacity: offering.capacity ? Number(offering.capacity) : null,
            pricing: {
              ...(earlyPriceCents === undefined
                ? {}
                : { earlyPriceCents, earlyEndsAt }),
              ...(latePriceCents === undefined
                ? {}
                : { latePriceCents, lateStartsAt }),
              installmentTemplateIds: offering.installmentTemplateId
                ? [offering.installmentTemplateId]
                : [],
              siblingDiscountEligible: offering.siblingDiscountEligible,
              glCode: null,
            },
            addOns,
            formDefinitionIds: formIds,
            waiverDocumentIds: waiverIds,
            visibility: 'public',
            active: true,
          },
          row,
        );
      }
      const refreshed = await apiGet(
        `/programs/orgs/${orgId}/${programId}`,
        programDetailSchema,
      );
      const published =
        refreshed.program.status === 'published'
          ? refreshed.program
          : await apiPost(
              `/programs/orgs/${orgId}/${programId}/status`,
              {
                status: 'published',
                expectedVersion: refreshed.program.version,
              },
              programSchema,
            );
      setNotice(
        `${published.name} is published with ${String(refreshed.divisions.length)} divisions and ${String(refreshed.offerings.length)} offerings`,
      );
      setStep(0);
    });

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
        <h2>Seasons</h2>
        <ul>
          {seasons.map((season) => (
            <li key={season.id}>
              <strong>{season.name}</strong> · {season.status} ·{' '}
              {season.starts_on.slice(0, 10)}–{season.ends_on.slice(0, 10)}{' '}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => {
                  setEditSeason(season);
                }}
              >
                Edit season
              </Button>
            </li>
          ))}
        </ul>
        {editSeason && (
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSeason();
            }}
          >
            <Field label="Season name">
              <Input
                value={editSeason.name}
                onChange={(event) => {
                  setEditSeason({ ...editSeason, name: event.target.value });
                }}
                required
              />
            </Field>
            <Field label="Starts">
              <Input
                type="date"
                value={editSeason.starts_on.slice(0, 10)}
                onChange={(event) => {
                  setEditSeason({
                    ...editSeason,
                    starts_on: event.target.value,
                  });
                }}
                required
              />
            </Field>
            <Field label="Ends">
              <Input
                type="date"
                value={editSeason.ends_on.slice(0, 10)}
                onChange={(event) => {
                  setEditSeason({ ...editSeason, ends_on: event.target.value });
                }}
                required
              />
            </Field>
            <Field label="Status">
              <Select
                value={editSeason.status}
                onChange={(event) => {
                  setEditSeason({ ...editSeason, status: event.target.value });
                }}
                options={[
                  editSeason.status,
                  ...(editSeason.status === 'planning'
                    ? ['active', 'archived']
                    : editSeason.status === 'active'
                      ? ['completed']
                      : editSeason.status === 'completed'
                        ? ['archived']
                        : []),
                ]}
              />
            </Field>
            <Button disabled={busy}>Save season</Button>{' '}
            <Button
              type="button"
              secondary
              onClick={() => {
                setEditSeason(null);
              }}
            >
              Cancel
            </Button>
          </form>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createSeason();
          }}
          className="phase3-form-row"
        >
          <Field label="Season name">
            <Input
              value={seasonName}
              onChange={(event) => {
                setSeasonName(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Starts">
            <Input
              type="date"
              value={seasonStart}
              onChange={(event) => {
                setSeasonStart(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Ends">
            <Input
              type="date"
              value={seasonEnd}
              onChange={(event) => {
                setSeasonEnd(event.target.value);
              }}
              required
            />
          </Field>
          <Button disabled={busy}>Create season</Button>
        </form>
        {seasons.length > 0 && (
          <SeasonRollover orgId={orgId} seasons={seasons} onCopied={load} />
        )}
      </Card>
      <Card>
        <h2>Sport profiles</h2>
        <ul>
          {profiles.map((profile) => (
            <li key={profile.id}>
              {profile.name} · version {profile.version}{' '}
              <Button
                type="button"
                secondary
                onClick={() => {
                  setEditProfileId(profile.id);
                }}
              >
                Edit profile
              </Button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void cloneSport();
          }}
          className="phase3-form-row"
        >
          <Field label="Built-in template">
            <Select
              value={templateKey}
              onChange={(event) => {
                setTemplateKey(event.target.value);
              }}
              required
            >
              <option value="">Choose sport</option>
              {templates.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.name.en}
                </option>
              ))}
            </Select>
          </Field>
          <Button disabled={busy}>Add sport profile</Button>
        </form>
        {editedProfile && (
          <SportProfileEditor
            orgId={orgId}
            profile={editedProfile}
            onSaved={load}
          />
        )}
      </Card>
      <Card>
        <h2>Programs</h2>
        <ul>
          {programs.map((program) => (
            <li key={program.id}>
              <a href={`/console/orgs/${orgId}/programs/${program.id}`}>
                {program.name}
              </a>{' '}
              · {program.status}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h2>Create program</h2>
        <p className="phase3-step">
          Step {step + 1} of 5 ·{' '}
          {
            [
              'Basics',
              'Divisions',
              'Offerings and pricing',
              'Forms and waivers',
              'Review',
            ][step]
          }
        </p>
        {step === 0 && (
          <div className="phase3-form-grid">
            <Field label="Season">
              <Select
                value={seasonId}
                onChange={(event) => {
                  setSeasonId(event.target.value);
                }}
              >
                <option value="">Choose season</option>
                {seasons.map((season) => (
                  <option key={season.id} value={season.id}>
                    {season.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sport profile">
              <Select
                value={profileId}
                onChange={(event) => {
                  setProfileId(event.target.value);
                }}
              >
                <option value="">Choose sport</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mode">
              <Select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value);
                }}
                options={modes}
              />
            </Field>
            <Field label="Program name">
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSlug(
                    event.target.value
                      .toLowerCase()
                      .trim()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, ''),
                  );
                }}
                required
              />
            </Field>
            <Field label="URL slug">
              <Input
                value={slug}
                onChange={(event) => {
                  setSlug(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Starts">
              <Input
                type="date"
                value={startsOn}
                onChange={(event) => {
                  setStartsOn(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Ends">
              <Input
                type="date"
                value={endsOn}
                onChange={(event) => {
                  setEndsOn(event.target.value);
                }}
                required
              />
            </Field>
          </div>
        )}
        {step === 1 && (
          <div className="phase3-form-grid">
            <p>
              Sport age method:{' '}
              {selectedProfile &&
              typeof selectedProfile.profile === 'object' &&
              selectedProfile.profile &&
              'ageGroup' in selectedProfile.profile
                ? JSON.stringify(selectedProfile.profile.ageGroup)
                : 'Choose sport'}
            </p>
            <Field label="Division method">
              <Select
                value={divisionMethod}
                onChange={(event) => {
                  setDivisionMethod(
                    event.target.value as typeof divisionMethod,
                  );
                }}
                options={[
                  { value: 'none', label: 'All participants' },
                  { value: 'birth_year', label: 'Age group (U)' },
                  { value: 'school_grade', label: 'School grade' },
                ]}
              />
            </Field>
            {divisionMethod !== 'none' && (
              <>
                <Field label="From">
                  <Input
                    type="number"
                    value={divisionFrom}
                    onChange={(event) => {
                      setDivisionFrom(event.target.value);
                    }}
                  />
                </Field>
                <Field label="To">
                  <Input
                    type="number"
                    value={divisionTo}
                    onChange={(event) => {
                      setDivisionTo(event.target.value);
                    }}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={boys}
                    onChange={(event) => {
                      setBoys(event.target.checked);
                    }}
                  />{' '}
                  Boys
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={girls}
                    onChange={(event) => {
                      setGirls(event.target.checked);
                    }}
                  />{' '}
                  Girls
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={coed}
                    onChange={(event) => {
                      setCoed(event.target.checked);
                    }}
                  />{' '}
                  Coed
                </label>
              </>
            )}
          </div>
        )}
        {step === 2 && (
          <div>
            <p>Price windows use the organization timezone: {orgTimezone}.</p>
            {offerings.map((offering, index) => (
              <div className="phase3-form-grid phase3-offering" key={index}>
                <Field label={`Offering ${String(index + 1)} name`}>
                  <Input
                    value={offering.name}
                    onChange={(event) => {
                      updateOffering(index, { name: event.target.value });
                    }}
                  />
                </Field>
                <Field label="Price ($)">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={offering.price}
                    onChange={(event) => {
                      updateOffering(index, { price: event.target.value });
                    }}
                  />
                </Field>
                <Field label="Capacity">
                  <Input
                    type="number"
                    min="0"
                    value={offering.capacity}
                    onChange={(event) => {
                      updateOffering(index, { capacity: event.target.value });
                    }}
                  />
                </Field>
                <Field label="Early-bird price ($)">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={offering.earlyPrice}
                    onChange={(event) => {
                      updateOffering(index, { earlyPrice: event.target.value });
                    }}
                  />
                </Field>
                <Field label={`Early-bird ends (${orgTimezone})`}>
                  <Input
                    type="datetime-local"
                    value={offering.earlyEndsAt}
                    onChange={(event) => {
                      updateOffering(index, {
                        earlyEndsAt: event.target.value,
                      });
                    }}
                  />
                </Field>
                <Field label="Late price ($)">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={offering.latePrice}
                    onChange={(event) => {
                      updateOffering(index, { latePrice: event.target.value });
                    }}
                  />
                </Field>
                <Field label={`Late pricing starts (${orgTimezone})`}>
                  <Input
                    type="datetime-local"
                    value={offering.lateStartsAt}
                    onChange={(event) => {
                      updateOffering(index, {
                        lateStartsAt: event.target.value,
                      });
                    }}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={offering.siblingDiscountEligible}
                    onChange={(event) => {
                      updateOffering(index, {
                        siblingDiscountEligible: event.target.checked,
                      });
                    }}
                  />{' '}
                  Eligible for sibling discounts
                </label>
                {plans.length > 0 && (
                  <Field label="Installment plan">
                    <Select
                      value={offering.installmentTemplateId}
                      onChange={(event) => {
                        updateOffering(index, {
                          installmentTemplateId: event.target.value,
                        });
                      }}
                    >
                      <option value="">Pay in full</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <fieldset>
                  <legend>Optional products and uniforms</legend>
                  {offering.addOns.map((addOn, addOnIndex) => (
                    <fieldset key={addOnIndex}>
                      <legend>Product {String(addOnIndex + 1)}</legend>
                      <Field label="Product name">
                        <Input
                          value={addOn.name}
                          onChange={(event) => {
                            updateAddOn(index, addOnIndex, {
                              name: event.target.value,
                            });
                          }}
                          required
                        />
                      </Field>
                      <Field label="Product price ($)">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={addOn.price}
                          onChange={(event) => {
                            updateAddOn(index, addOnIndex, {
                              price: event.target.value,
                            });
                          }}
                        />
                      </Field>
                      <Field label="Choices or sizes (comma-separated)">
                        <Input
                          value={addOn.options}
                          onChange={(event) => {
                            updateAddOn(index, addOnIndex, {
                              options: event.target.value,
                            });
                          }}
                          placeholder="Youth small, Youth medium, Adult small"
                        />
                      </Field>
                      <label>
                        <input
                          type="checkbox"
                          checked={addOn.required}
                          onChange={(event) => {
                            updateAddOn(index, addOnIndex, {
                              required: event.target.checked,
                            });
                          }}
                        />{' '}
                        Required with this offering
                      </label>{' '}
                      <Button
                        type="button"
                        secondary
                        onClick={() => {
                          updateOffering(index, {
                            addOns: offering.addOns.filter(
                              (_, at) => at !== addOnIndex,
                            ),
                          });
                        }}
                      >
                        Remove product
                      </Button>
                    </fieldset>
                  ))}
                  <Button
                    type="button"
                    secondary
                    onClick={() => {
                      updateOffering(index, {
                        addOns: [...offering.addOns, emptyAddOn()],
                      });
                    }}
                  >
                    Add product or uniform
                  </Button>
                </fieldset>
              </div>
            ))}
            <Button
              type="button"
              secondary
              onClick={() => {
                setOfferings((current) => [...current, emptyOffering()]);
              }}
            >
              Add offering
            </Button>
          </div>
        )}
        {step === 3 && (
          <div className="phase3-form-grid">
            <label>
              <input
                type="checkbox"
                checked={emergencyContact}
                onChange={(event) => {
                  setEmergencyContact(event.target.checked);
                }}
              />{' '}
              Require emergency contact
            </label>
            <label>
              <input
                type="checkbox"
                checked={medicalSection}
                onChange={(event) => {
                  setMedicalSection(event.target.checked);
                }}
              />{' '}
              Require medical section
            </label>
            <fieldset>
              <legend>Forms</legend>
              {libraries.forms.length === 0 && (
                <p>No published forms in the library.</p>
              )}
              {libraries.forms.map((form) => (
                <label key={form.id}>
                  <input
                    type="checkbox"
                    checked={formIds.includes(form.id)}
                    onChange={(event) => {
                      setFormIds((current) =>
                        event.target.checked
                          ? [...current, form.id]
                          : current.filter((id) => id !== form.id),
                      );
                    }}
                  />{' '}
                  {form.name} · v{form.version} · {form.scope}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Waivers</legend>
              {libraries.waivers.length === 0 && (
                <p>No published waivers in the library.</p>
              )}
              {libraries.waivers.map((waiver) => (
                <label key={waiver.id}>
                  <input
                    type="checkbox"
                    checked={waiverIds.includes(waiver.id)}
                    onChange={(event) => {
                      setWaiverIds((current) =>
                        event.target.checked
                          ? [...current, waiver.id]
                          : current.filter((id) => id !== waiver.id),
                      );
                    }}
                  />{' '}
                  {waiver.name} · v{waiver.version} ·{' '}
                  {waiver.requires.replaceAll('_', ' ')} ·{' '}
                  {waiver.renewal.replaceAll('_', ' ')}
                </label>
              ))}
            </fieldset>
          </div>
        )}
        {step === 4 && (
          <div>
            <p>
              <strong>{name}</strong> · {mode} · {startsOn} to {endsOn}
            </p>
            <p>
              {divisionMethod === 'none'
                ? 'All participants'
                : `${divisionFrom}–${divisionTo} ${divisionMethod.replace('_', ' ')}`}{' '}
              · {offerings.length} offering(s)
            </p>
            <p>
              {plans.length
                ? 'Installment plans selected in offerings'
                : 'Pay in full; no installment templates available'}{' '}
              · {formIds.length} form(s) · {waiverIds.length} waiver(s)
            </p>
          </div>
        )}
        <div className="phase3-actions">
          <Button
            type="button"
            secondary
            disabled={step === 0 || busy}
            onClick={() => {
              setStep((current) => current - 1);
            }}
          >
            Back
          </Button>
          {step < 4 ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setStep((current) => current + 1);
              }}
            >
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void submitWizard();
              }}
            >
              Create and publish
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
