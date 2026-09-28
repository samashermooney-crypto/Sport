import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Button,
  Card,
  Field,
  Input,
  Link,
  Select,
  Textarea,
} from '../../ui/primitives';

import './programs.css';

const programSchema = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  mode: z.string(),
  status: z.string(),
  visibility: z.string(),
  starts_on: z.string(),
  ends_on: z.string(),
  description_html: z.string().nullable(),
  version: z.number().int().positive(),
  settings: z.unknown(),
});
const divisionSchema = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  age_label: z.string().nullable(),
  is_default: z.boolean(),
});
const offeringSchema = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  price_cents: z.number(),
  capacity: z.number().nullable(),
  active: z.boolean(),
});
const detailSchema = z.object({
  program: programSchema,
  divisions: z.array(divisionSchema),
  offerings: z.array(offeringSchema),
});
const planSchema = z.object({
  templates: z.array(z.looseObject({ id: z.uuid(), name: z.string() })),
});

export function ProgramDetail({
  orgId,
  programId,
}: {
  orgId: string;
  programId: string;
}): React.JSX.Element {
  const [detail, setDetail] = useState<z.output<typeof detailSchema> | null>(
    null,
  );
  const [plans, setPlans] = useState<z.output<typeof planSchema>['templates']>(
    [],
  );
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [description, setDescription] = useState('');
  const [settings, setSettings] = useState('{}');
  const [divisionName, setDivisionName] = useState('');
  const [offeringName, setOfferingName] = useState('');
  const [price, setPrice] = useState('0');
  const [capacity, setCapacity] = useState('');
  const [planId, setPlanId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [nextDetail, nextPlans] = await Promise.all([
      apiGet(`/programs/orgs/${orgId}/${programId}`, detailSchema),
      apiGet(`/offerings/orgs/${orgId}/installment-templates`, planSchema),
    ]);
    setDetail(nextDetail);
    setPlans(nextPlans.templates);
    setName(nextDetail.program.name);
    setSlug(nextDetail.program.slug);
    setStartsOn(nextDetail.program.starts_on.slice(0, 10));
    setEndsOn(nextDetail.program.ends_on.slice(0, 10));
    setVisibility(nextDetail.program.visibility);
    setDescription(nextDetail.program.description_html ?? '');
    setSettings(JSON.stringify(nextDetail.program.settings, null, 2));
  }, [orgId, programId]);
  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Program unavailable');
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
  if (!detail) return <p role="status">Loading program…</p>;
  const { program, divisions, offerings } = detail;
  return (
    <div className="phase3-stack">
      <p>
        <Link to={`/console/orgs/${orgId}/programs`}>All programs</Link>
      </p>
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
        <h2>{program.name}</h2>
        <p>
          {program.mode} · {program.status} · /programs/{program.slug}
        </p>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              await apiPatch(
                `/programs/orgs/${orgId}/${programId}`,
                {
                  expectedVersion: program.version,
                  name,
                  slug,
                  startsOn,
                  endsOn,
                  visibility,
                  descriptionHtml: description || null,
                  settings: JSON.parse(settings) as unknown,
                },
                programSchema,
              );
              setNotice('Program settings saved');
            });
          }}
        >
          <Field label="Name">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              required
            />
          </Field>
          <Field
            label="URL slug"
            hint={
              program.status === 'draft'
                ? 'Can be changed before publishing'
                : 'Unpublish before changing'
            }
          >
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
          <Field label="Visibility">
            <Select
              value={visibility}
              onChange={(event) => {
                setVisibility(event.target.value);
              }}
              options={['private', 'unlisted', 'public']}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
          <Field
            label="Program settings JSON"
            hint="Waitlist, roster visibility, standings, uniforms, volunteer rules and mode settings"
          >
            <Textarea
              rows={8}
              value={settings}
              onChange={(event) => {
                setSettings(event.target.value);
              }}
              spellCheck={false}
            />
          </Field>
          <Button disabled={busy}>Save settings</Button>
        </form>
        <div className="phase3-actions">
          {program.status === 'draft' && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void mutate(async () => {
                  await apiPost(
                    `/programs/orgs/${orgId}/${programId}/status`,
                    { status: 'published', expectedVersion: program.version },
                    programSchema,
                  );
                  setNotice('Program published');
                });
              }}
            >
              Publish
            </Button>
          )}
          {program.status === 'published' && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void mutate(async () => {
                  await apiPost(
                    `/programs/orgs/${orgId}/${programId}/status`,
                    { status: 'draft', expectedVersion: program.version },
                    programSchema,
                  );
                  setNotice('Program unpublished');
                });
              }}
            >
              Unpublish
            </Button>
          )}
        </div>
      </Card>
      <Card>
        <h2>Divisions</h2>
        {divisions.length > 1 && (
          <ul>
            {divisions.map((division) => (
              <li key={division.id}>
                {division.name}
                {division.is_default ? ' · default' : ''}
              </li>
            ))}
          </ul>
        )}
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              await apiPost(
                `/programs/orgs/${orgId}/${programId}/divisions`,
                { name: divisionName },
                divisionSchema,
              );
              setDivisionName('');
              setNotice('Division added');
            });
          }}
        >
          <Field label="Division name">
            <Input
              value={divisionName}
              onChange={(event) => {
                setDivisionName(event.target.value);
              }}
              required
            />
          </Field>
          <Button disabled={busy}>Add division</Button>
        </form>
      </Card>
      <Card>
        <h2>Registration offerings</h2>
        <ul>
          {offerings.map((offering) => (
            <li key={offering.id}>
              {offering.name} · ${(offering.price_cents / 100).toFixed(2)} ·{' '}
              {offering.active ? 'Active' : 'Draft'}
            </li>
          ))}
        </ul>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              await apiPost(
                `/offerings/orgs/${orgId}`,
                {
                  programId,
                  name: offeringName,
                  registrantRole: 'athlete',
                  priceCents: Math.round(Number(price) * 100),
                  capacity: capacity ? Number(capacity) : null,
                  pricing: {
                    installmentTemplateIds: planId ? [planId] : [],
                    siblingDiscountEligible: true,
                    glCode: null,
                  },
                  visibility: 'public',
                  active: true,
                },
                offeringSchema,
              );
              setOfferingName('');
              setNotice('Offering added');
            });
          }}
        >
          <Field label="Offering name">
            <Input
              value={offeringName}
              onChange={(event) => {
                setOfferingName(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Price ($)">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(event) => {
                setPrice(event.target.value);
              }}
            />
          </Field>
          <Field label="Capacity">
            <Input
              type="number"
              min="0"
              value={capacity}
              onChange={(event) => {
                setCapacity(event.target.value);
              }}
            />
          </Field>
          {plans.length > 0 && (
            <Field label="Installment plan">
              <Select
                value={planId}
                onChange={(event) => {
                  setPlanId(event.target.value);
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
          <Button disabled={busy}>Add offering</Button>
        </form>
      </Card>
    </div>
  );
}
