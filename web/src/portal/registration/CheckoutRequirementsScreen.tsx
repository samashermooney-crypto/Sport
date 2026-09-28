import { formatMoney } from '@shared/money';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';

import '../money/money.css';

const fieldSchema = z.looseObject({
  key: z.string(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
});
const discoverySchema = z.strictObject({
  checkoutId: z.uuid(),
  status: z.string(),
  lines: z.array(
    z.strictObject({
      lineId: z.uuid(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      personId: z.uuid(),
      personName: z.string(),
      requiresApproval: z.boolean(),
      forms: z.array(
        z.strictObject({
          formDefinitionId: z.uuid(),
          name: z.string(),
          version: z.number().int().positive(),
          fields: z.array(fieldSchema),
          reusableAnswers: z.record(z.string(), z.unknown()).nullable(),
        }),
      ),
      waivers: z.array(
        z.strictObject({
          waiverDocumentId: z.uuid(),
          name: z.string(),
          version: z.number().int().positive(),
          documentHash: z.string(),
          requires: z.string(),
          bodyHtml: z.string(),
        }),
      ),
      addOns: z.array(
        z.strictObject({
          key: z.string(),
          name: z.string(),
          priceCents: z.number().int().nonnegative(),
          required: z.boolean().optional(),
          sizes: z.array(z.string()).optional(),
          maxQuantity: z.number().int().positive().optional(),
          description: z.string().optional(),
        }),
      ),
      volunteerRequirement: z
        .strictObject({
          required: z.boolean(),
          buyoutCents: z.number().int().nonnegative(),
          description: z.string().optional(),
        })
        .nullable(),
    }),
  ),
  creditAvailableCents: z.number().int().nonnegative(),
  installmentTemplates: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      deposit: z.unknown(),
      schedule: z.unknown(),
      minAmountCents: z.number().int().nonnegative(),
      autopayRequired: z.boolean(),
      allowedMethods: z.array(z.string()),
    }),
  ),
  requirementsSubmitted: z.boolean(),
});
const submittedSchema = z.strictObject({
  checkoutId: z.uuid(),
  requirementsSubmitted: z.literal(true),
});
function formKey(lineId: string, formId: string): string {
  return `${lineId}:${formId}`;
}

function choiceKey(lineId: string, key: string): string {
  return `${lineId}:${key}`;
}

function waiverText(bodyHtml: string): string {
  return bodyHtml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function CheckoutRequirementsScreen({
  orgId,
  checkoutId,
}: {
  orgId: string;
  checkoutId: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const [answers, setAnswers] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [addOns, setAddOns] = useState<
    Record<string, { quantity: number; size: string }>
  >({});
  const [volunteer, setVolunteer] = useState<
    Record<string, 'commit' | 'buyout' | 'none'>
  >({});
  const [waiverAcceptances, setWaiverAcceptances] = useState<
    Record<
      string,
      { accepted: boolean; signerName: string; participantSignerName: string }
    >
  >({});
  const [discountCodes, setDiscountCodes] = useState('');
  const [applyCreditCents, setApplyCreditCents] = useState(0);
  const [planTemplateId, setPlanTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/registration/orgs/${encodeURIComponent(orgId)}/checkouts/${encodeURIComponent(checkoutId)}`;
  const query = useQuery({
    queryKey: ['registration', orgId, 'requirements', checkoutId],
    queryFn: () => apiGet(`${base}/requirements`, discoverySchema),
  });
  useEffect(() => {
    const data = query.data;
    if (!data) return;
    setAnswers((current) => {
      if (Object.keys(current).length) return current;
      return Object.fromEntries(
        data.lines.flatMap((line) =>
          line.forms.map((form) => [
            formKey(line.lineId, form.formDefinitionId),
            form.reusableAnswers ?? {},
          ]),
        ),
      );
    });
    setVolunteer((current) => {
      if (Object.keys(current).length) return current;
      return Object.fromEntries(
        data.lines.map((line) => [
          line.lineId,
          line.volunteerRequirement?.required ? 'commit' : 'none',
        ]),
      );
    });
    setAddOns((current) => {
      if (Object.keys(current).length) return current;
      return Object.fromEntries(
        data.lines.flatMap((line) =>
          line.addOns
            .filter((addOn) => addOn.required)
            .map((addOn) => [
              choiceKey(line.lineId, addOn.key),
              { quantity: 1, size: addOn.sizes?.[0] ?? '' },
            ]),
        ),
      );
    });
  }, [query.data]);
  const plans = useMemo(
    () =>
      query.data?.installmentTemplates.filter(
        (template) => !template.autopayRequired,
      ) ?? [],
    [query.data],
  );
  const submit = async (): Promise<void> => {
    const data = query.data;
    if (!data || busy) return;
    setBusy(true);
    setError('');
    try {
      const missingWaiver = data.lines.some((line) =>
        line.waivers.some((waiver) => {
          const signature =
            waiverAcceptances[formKey(line.lineId, waiver.waiverDocumentId)];
          return (
            !signature?.accepted ||
            !signature.signerName.trim() ||
            (waiver.requires === 'both' &&
              !signature.participantSignerName.trim())
          );
        }),
      );
      if (missingWaiver)
        throw new Error('Accept each waiver and enter the signer’s full name.');
      await apiPost(
        `${base}/requirements`,
        {
          version: 1,
          lines: data.lines.map((line) => ({
            lineId: line.lineId,
            addOns: line.addOns.flatMap((addOn) => {
              const selection = addOns[choiceKey(line.lineId, addOn.key)];
              if (!selection) return [];
              return [
                {
                  key: addOn.key,
                  quantity: selection.quantity,
                  ...(selection.size ? { size: selection.size } : {}),
                },
              ];
            }),
            volunteer: volunteer[line.lineId] ?? 'none',
          })),
          forms: data.lines.flatMap((line) =>
            line.forms.map((form) => ({
              lineId: line.lineId,
              formDefinitionId: form.formDefinitionId,
              definitionVersion: form.version,
              answers:
                answers[formKey(line.lineId, form.formDefinitionId)] ?? {},
            })),
          ),
          waivers: data.lines.flatMap((line) =>
            line.waivers.map((waiver) => {
              const acceptance =
                waiverAcceptances[
                  formKey(line.lineId, waiver.waiverDocumentId)
                ];
              return {
                lineId: line.lineId,
                waiverDocumentId: waiver.waiverDocumentId,
                documentVersion: waiver.version,
                documentHash: waiver.documentHash,
                accepted:
                  waiverAcceptances[
                    formKey(line.lineId, waiver.waiverDocumentId)
                  ]?.accepted === true,
                signerName: acceptance?.signerName ?? '',
                ...(waiver.requires === 'both'
                  ? {
                      participantSignerName:
                        acceptance?.participantSignerName ?? '',
                    }
                  : {}),
                method: 'online_typed' as const,
              };
            }),
          ),
          discountCodes: discountCodes
            .split(',')
            .map((code) => code.trim())
            .filter(Boolean),
          applyCreditCents,
          planTemplateId: planTemplateId || null,
          chargeOnApprovalMethodId: null,
        },
        submittedSchema,
      );
      void navigate(`/portal/orgs/${orgId}/register/checkouts/${checkoutId}`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Requirements could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="REGISTRATION"
          title="Participant details"
          description="Complete forms, waivers and program choices before reviewing payment."
        />
        <p>
          <Link to={`/portal/orgs/${orgId}/register`}>Back to programs</Link>
        </p>
        {query.isLoading && (
          <p role="status">Loading participant requirements…</p>
        )}
        {query.error && (
          <p role="alert" className="money-error">
            Requirements are unavailable. Refresh and try again.
          </p>
        )}
        {query.data && (
          <>
            {query.data.lines.map((line) => (
              <section
                className="money-panel"
                key={line.lineId}
                aria-labelledby={`participant-${line.lineId}`}
              >
                <h2 id={`participant-${line.lineId}`}>
                  {line.personName} · {line.offeringName}
                </h2>
                {line.requiresApproval && (
                  <p>This program reviews registrations before confirmation.</p>
                )}
                {line.forms.map((form) => (
                  <fieldset key={form.formDefinitionId}>
                    <legend>{form.name}</legend>
                    {form.fields.map((field) => {
                      const id = `${line.lineId}-${form.formDefinitionId}-${field.key}`;
                      const formId = formKey(
                        line.lineId,
                        form.formDefinitionId,
                      );
                      const value = answers[formId]?.[field.key];
                      if (
                        field.type === 'checkbox' ||
                        field.type === 'boolean'
                      ) {
                        return (
                          <label key={field.key} htmlFor={id}>
                            <input
                              id={id}
                              type="checkbox"
                              checked={value === true}
                              required={field.required}
                              onChange={(event) => {
                                setAnswers((current) => ({
                                  ...current,
                                  [formId]: {
                                    ...current[formId],
                                    [field.key]: event.target.checked,
                                  },
                                }));
                              }}
                            />
                            {field.label ?? field.key}
                            {field.required ? ' *' : ''}
                          </label>
                        );
                      }
                      return (
                        <label key={field.key} htmlFor={id}>
                          {field.label ?? field.key}
                          {field.required ? ' *' : ''}
                          {field.options?.length ? (
                            <select
                              id={id}
                              required={field.required}
                              value={typeof value === 'string' ? value : ''}
                              onChange={(event) => {
                                setAnswers((current) => ({
                                  ...current,
                                  [formId]: {
                                    ...current[formId],
                                    [field.key]: event.target.value,
                                  },
                                }));
                              }}
                            >
                              <option value="">Choose an answer</option>
                              {field.options.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          ) : field.type === 'textarea' ||
                            field.type === 'long_text' ? (
                            <textarea
                              id={id}
                              required={field.required}
                              value={typeof value === 'string' ? value : ''}
                              onChange={(event) => {
                                setAnswers((current) => ({
                                  ...current,
                                  [formId]: {
                                    ...current[formId],
                                    [field.key]: event.target.value,
                                  },
                                }));
                              }}
                            />
                          ) : (
                            <input
                              id={id}
                              type={
                                ['email', 'number', 'date', 'tel'].includes(
                                  field.type ?? '',
                                )
                                  ? field.type
                                  : 'text'
                              }
                              required={field.required}
                              value={
                                typeof value === 'string' ||
                                typeof value === 'number'
                                  ? String(value)
                                  : ''
                              }
                              onChange={(event) => {
                                setAnswers((current) => ({
                                  ...current,
                                  [formId]: {
                                    ...current[formId],
                                    [field.key]:
                                      field.type === 'number' &&
                                      event.target.value
                                        ? Number(event.target.value)
                                        : event.target.value,
                                  },
                                }));
                              }}
                            />
                          )}
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
                {line.waivers.map((waiver) => {
                  const key = formKey(line.lineId, waiver.waiverDocumentId);
                  const acceptance = waiverAcceptances[key] ?? {
                    accepted: false,
                    signerName: '',
                    participantSignerName: '',
                  };
                  return (
                    <fieldset key={waiver.waiverDocumentId}>
                      <legend>{waiver.name}</legend>
                      <p>{waiverText(waiver.bodyHtml)}</p>
                      <p>
                        Signer requirement:{' '}
                        {waiver.requires.replaceAll('_', ' ')}.
                      </p>
                      <label>
                        <input
                          type="checkbox"
                          required
                          checked={acceptance.accepted}
                          onChange={(event) => {
                            setWaiverAcceptances((current) => ({
                              ...current,
                              [key]: {
                                ...acceptance,
                                accepted: event.target.checked,
                              },
                            }));
                          }}
                        />
                        I have read and agree to this waiver.
                      </label>
                      <label>
                        {waiver.requires === 'participant'
                          ? 'Participant signer full name'
                          : waiver.requires === 'both'
                            ? 'Guardian signer full name'
                            : 'Guardian or adult participant signer full name'}
                        <input
                          required
                          value={acceptance.signerName}
                          onChange={(event) => {
                            setWaiverAcceptances((current) => ({
                              ...current,
                              [key]: {
                                ...acceptance,
                                signerName: event.target.value,
                              },
                            }));
                          }}
                        />
                      </label>
                      {waiver.requires === 'both' && (
                        <label>
                          Participant signer full name
                          <input
                            required
                            value={acceptance.participantSignerName}
                            onChange={(event) => {
                              setWaiverAcceptances((current) => ({
                                ...current,
                                [key]: {
                                  ...acceptance,
                                  participantSignerName: event.target.value,
                                },
                              }));
                            }}
                          />
                        </label>
                      )}
                    </fieldset>
                  );
                })}
                {line.addOns.length > 0 && (
                  <fieldset>
                    <legend>Optional items</legend>
                    {line.addOns.map((addOn) => {
                      const key = choiceKey(line.lineId, addOn.key);
                      const selection = addOns[key];
                      return (
                        <div key={addOn.key}>
                          <label>
                            <input
                              type="checkbox"
                              checked={Boolean(selection)}
                              disabled={addOn.required}
                              onChange={(event) => {
                                setAddOns((current) => {
                                  if (!event.target.checked) {
                                    return Object.fromEntries(
                                      Object.entries(current).filter(
                                        ([entryKey]) => entryKey !== key,
                                      ),
                                    );
                                  }
                                  return {
                                    ...current,
                                    [key]: {
                                      quantity: 1,
                                      size: addOn.sizes?.[0] ?? '',
                                    },
                                  };
                                });
                              }}
                            />
                            {addOn.name}
                            {addOn.required ? ' (required)' : ''}
                          </label>
                          {selection && (
                            <>
                              <label>
                                Quantity
                                <input
                                  type="number"
                                  min={1}
                                  max={addOn.maxQuantity ?? 10}
                                  value={selection.quantity}
                                  onChange={(event) => {
                                    setAddOns((current) => ({
                                      ...current,
                                      [key]: {
                                        ...selection,
                                        quantity: Number(event.target.value),
                                      },
                                    }));
                                  }}
                                />
                              </label>
                              {addOn.sizes && addOn.sizes.length > 0 && (
                                <label>
                                  Size
                                  <select
                                    required
                                    value={selection.size}
                                    onChange={(event) => {
                                      setAddOns((current) => ({
                                        ...current,
                                        [key]: {
                                          ...selection,
                                          size: event.target.value,
                                        },
                                      }));
                                    }}
                                  >
                                    {addOn.sizes.map((size) => (
                                      <option key={size} value={size}>
                                        {size}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </fieldset>
                )}
                {line.volunteerRequirement && (
                  <fieldset>
                    <legend>Volunteer requirement</legend>
                    {line.volunteerRequirement.description && (
                      <p>{line.volunteerRequirement.description}</p>
                    )}
                    <label>
                      <input
                        type="radio"
                        name={`volunteer-${line.lineId}`}
                        checked={volunteer[line.lineId] === 'commit'}
                        onChange={() => {
                          setVolunteer((current) => ({
                            ...current,
                            [line.lineId]: 'commit',
                          }));
                        }}
                      />
                      I will volunteer
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`volunteer-${line.lineId}`}
                        checked={volunteer[line.lineId] === 'buyout'}
                        onChange={() => {
                          setVolunteer((current) => ({
                            ...current,
                            [line.lineId]: 'buyout',
                          }));
                        }}
                      />
                      Pay the volunteer buyout
                    </label>
                  </fieldset>
                )}
              </section>
            ))}
            {query.data.creditAvailableCents > 0 && (
              <section className="money-panel">
                <h2>Account credit</h2>
                <p>
                  Available credit:{' '}
                  {formatMoney(query.data.creditAvailableCents, i18n.language)}
                </p>
                <label>
                  Credit to apply (cents)
                  <input
                    type="number"
                    min={0}
                    max={query.data.creditAvailableCents}
                    value={applyCreditCents}
                    onChange={(event) => {
                      setApplyCreditCents(Number(event.target.value));
                    }}
                  />
                </label>
              </section>
            )}
            <section className="money-panel">
              <h2>Payment options</h2>
              <label>
                Discount codes
                <input
                  value={discountCodes}
                  onChange={(event) => {
                    setDiscountCodes(event.target.value);
                  }}
                  placeholder="Separate codes with commas"
                />
              </label>
              {plans.length > 0 && (
                <label>
                  Installment plan
                  <select
                    value={planTemplateId}
                    onChange={(event) => {
                      setPlanTemplateId(event.target.value);
                    }}
                  >
                    <option value="">Pay in full</option>
                    {plans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p>
                Installment schedules requiring automatic charges can’t be
                selected here.
              </p>
            </section>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? 'Saving participant details…' : 'Continue to review'}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="money-error">
            {error}
          </p>
        )}
      </main>
    </PortalShell>
  );
}
