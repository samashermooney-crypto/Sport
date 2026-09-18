import { MemberPropertySettings } from "./member-properties";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "./api";
import {
  Button,
  Check,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  useData,
} from "./components";
import { HtmlContent, RichText } from "./rich-text";
import { ProgramNav } from "./programs";
import type { ReactNode } from "react";

export type CustomField = {
  id: string;
  name: string;
  tag: string;
  type: string;
  required: boolean;
  visibility: string;
  apply: string;
  order: number;
  roles: string[];
  staff_roles: string[];
  roster_required: boolean;
  managed_by_staff: boolean;
  options: string[];
};
export type Waiver = {
  id: string;
  version: number;
  name: string;
  kind: string;
  content: string;
  enabled: boolean;
  required: boolean;
  apply: string;
  order: number;
  roles: string[];
  staff_roles: string[];
};
export type FormDefinition = {
  version: number;
  fields: CustomField[];
  waivers: Waiver[];
};
const blankDefinition: FormDefinition = { version: 1, fields: [], waivers: [] };
const roleOptions = ["Team", "Team Player", "Free Agent", "Program Staff"];
const types = [
  "Single Text",
  "Paragraph",
  "Numeric",
  "Dropdown",
  "Multiple Checkboxes",
  "File Upload",
];
const newField = (): CustomField => ({
  id: crypto.randomUUID(),
  name: "",
  tag: "",
  type: "Single Text",
  required: true,
  visibility: "Private",
  apply: "Always",
  order: 0,
  roles: ["Team Player", "Free Agent", "Program Staff"],
  staff_roles: [],
  roster_required: false,
  managed_by_staff: false,
  options: [],
});
const newWaiver = (): Waiver => ({
  id: crypto.randomUUID(),
  version: 1,
  name: "",
  kind: "Additional Waiver",
  content: "",
  enabled: true,
  required: true,
  apply: "Always",
  order: 0,
  roles: ["Team Player", "Free Agent", "Program Staff"],
  staff_roles: [],
});

export type RegistrationFormValues = {
  answers: Record<string, string | number | string[]>;
  waiver_acceptances: {
    waiver_id: string;
    waiver_version: number;
    signer_id: string;
  }[];
  form_version: number;
  has_waivers: boolean;
  profile_record_version?: number;
};
export function RegistrationQuestions({
  programId,
  personId,
  role,
  onChange,
}: {
  programId: string;
  personId: string;
  role: string;
  onChange: (value: RegistrationFormValues) => void;
}) {
  const path = `/registration-form?${new URLSearchParams({ program_id: programId, person_id: personId, role })}`;
  return <Questionnaire path={path} onChange={onChange} />;
}
export function ProfileQuestions({
  personId,
  birthdate,
  kind,
  onChange,
  memberOrg,
}: {
  memberOrg?: string;
  personId?: string;
  birthdate: string;
  kind: string;
  onChange: (value: RegistrationFormValues) => void;
}) {
  return (
    <Questionnaire
      path={`${memberOrg ? `/member/${memberOrg}` : ""}/profile-form?${new URLSearchParams({ person_id: personId || "" })}`}
      memberOrg={memberOrg}
      profile={{ birthdate, kind }}
      onChange={onChange}
    />
  );
}
function Questionnaire({
  memberOrg,
  path,
  profile,
  onChange,
}: {
  memberOrg?: string;
  path: string;
  profile?: { birthdate: string; kind: string };
  onChange: (value: RegistrationFormValues) => void;
}) {
  const state = useData<QuestionnaireData>(path, blankDefinition);
  return (
    <QuestionnaireBody
      key={path}
      {...state}
      memberOrg={memberOrg}
      profile={profile}
      onChange={onChange}
    />
  );
}
export type QuestionnaireData = FormDefinition & {
  signers?: { id: string; name: string }[];
  answers?: RegistrationFormValues["answers"];
  record_version?: number;
  today?: string;
};
export function MemberRegistrationQuestions({
  form,
  org,
  onChange,
}: {
  form: QuestionnaireData;
  org: string;
  onChange: (value: RegistrationFormValues) => void;
}) {
  return (
    <QuestionnaireBody
      data={form}
      loading={false}
      error=""
      reload={() => {}}
      memberOrg={org}
      onChange={onChange}
    />
  );
}
function QuestionnaireBody({
  data,
  loading,
  error,
  reload,
  memberOrg,
  profile,
  onChange,
}: {
  data: QuestionnaireData;
  loading: boolean;
  error: string;
  reload: () => void;
  memberOrg?: string;
  profile?: { birthdate: string; kind: string };
  onChange: (value: RegistrationFormValues) => void;
}) {
  const fields = useMemo(() => {
    if (!profile) return data.fields;
    const [y, m, d] = profile.birthdate.split("-").map(Number);
    const [cy, cm, cd] = (data.today || "").split("-").map(Number);
    const adult = profile.birthdate
      ? cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) >= 18
      : ["parent", "staff"].includes(profile.kind);
    return data.fields
      .filter(
        (f) => f.apply === "Always" || (f.apply === "Adults" ? adult : !adult),
      )
      .map((f) => ({ ...f, required: memberOrg ? f.required : false }))
      .sort((a, b) => a.order - b.order);
  }, [
    memberOrg,
    data.fields,
    data.today,
    !!profile,
    profile?.birthdate,
    profile?.kind,
  ]);
  const [values, setValues] = useState<RegistrationFormValues>({
      answers: {},
      waiver_acceptances: [],
      form_version: 0,
      has_waivers: false,
    }),
    [failure, setFailure] = useState(""),
    [uploading, setUploading] = useState(false),
    [fileNames, setFileNames] = useState<Record<string, string>>({});
  const callback = useRef(onChange);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  callback.current = onChange;
  useEffect(() => {
    if (!loading && !error) {
      const next = {
        answers: data.answers || {},
        waiver_acceptances: [],
        form_version: data.version,
        has_waivers: !!data.waivers.length,
        profile_record_version: data.record_version,
      };
      setValues(next);
    }
  }, [data, loading, error]);
  useEffect(() => {
    if (!loading && !error)
      callback.current({
        ...values,
        answers: Object.fromEntries(
          Object.entries(values.answers).filter(([id]) =>
            fields.some((f) => f.id === id),
          ),
        ),
        form_version: uploading ? 0 : values.form_version,
      });
  }, [values, fields, loading, error, uploading]);
  const update = (next: RegistrationFormValues) => {
    setValues(next);
  };
  const answer = (id: string, value: string | number | string[]) =>
    update({ ...values, answers: { ...values.answers, [id]: value } });
  if (loading) return <Loading />;
  if (error)
    return (
      <>
        <ErrorBox error={error} />
        <Button type="button" secondary onClick={reload}>
          Reload form
        </Button>
      </>
    );
  const adults = data.signers || [];
  return (
    <section className="registration-questions">
      <fieldset className="question-upload-group" disabled={uploading}>
        <ErrorBox error={failure} />
        {fields.length > 0 && (
          <h3>{profile ? "Profile questions" : "Registration questions"}</h3>
        )}
        {profile && !memberOrg && fields.length > 0 && (
          <p className="muted">
            As an admin, you may skip additional required profile questions.
          </p>
        )}
        {fields.map((f) => {
          const value = values.answers[f.id] ?? "";
          return (
            <QuestionField key={f.id} field={f}>
              {f.type === "Paragraph" ? (
                <textarea
                  required={f.required}
                  rows={4}
                  maxLength={10000}
                  value={String(value)}
                  onChange={(e) => answer(f.id, e.target.value)}
                />
              ) : f.type === "Dropdown" ? (
                <Select
                  required={f.required}
                  value={String(value)}
                  options={[
                    { value: "", label: "Select an option" },
                    ...f.options.map((o) => ({ value: o, label: o })),
                  ]}
                  onChange={(e) => answer(f.id, e.target.value)}
                />
              ) : f.type === "Multiple Checkboxes" ? (
                <span className="question-checkboxes">
                  {f.options.map((o) => (
                    <Check
                      key={o}
                      checked={Array.isArray(value) && value.includes(o)}
                      onChange={(e) =>
                        answer(
                          f.id,
                          e.target.checked
                            ? [...(Array.isArray(value) ? value : []), o]
                            : (Array.isArray(value) ? value : []).filter(
                                (v) => v !== o,
                              ),
                        )
                      }
                    >
                      {o}
                    </Check>
                  ))}
                </span>
              ) : f.type === "File Upload" ? (
                <>
                  <input
                    key={String(value)}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp,text/plain"
                    disabled={uploading}
                    required={f.required && !value}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) {
                        setFailure("Files must be 5MB or smaller.");
                        e.target.value = "";
                        return;
                      }
                      setUploading(true);
                      setFailure("");
                      try {
                        const saved = await api<{ id: string; name: string }>(
                          `${memberOrg ? `/member/${memberOrg}` : ""}/form-files`,
                          {
                            method: "POST",
                            headers: {
                              "Content-Type": file.type || "text/plain",
                              "X-File-Name": encodeURIComponent(file.name),
                            },
                            body: file,
                          },
                        );
                        if (!alive.current) return;
                        setFileNames((old) => ({ ...old, [f.id]: file.name }));
                        answer(f.id, saved.id);
                      } catch (e) {
                        if (!alive.current) return;
                        setFailure((e as Error).message);
                      } finally {
                        if (alive.current) setUploading(false);
                      }
                    }}
                  />
                  {value && (
                    <small>
                      <a
                        href={`/api${memberOrg ? `/member/${memberOrg}` : ""}/form-files/${encodeURIComponent(String(value))}`}
                        download
                      >
                        {fileNames[f.id] || "Download attachment"}
                      </a>{" "}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => answer(f.id, "")}
                      >
                        Remove
                      </button>
                    </small>
                  )}
                </>
              ) : (
                <input
                  required={f.required}
                  type={f.type === "Numeric" ? "number" : "text"}
                  step="any"
                  maxLength={500}
                  value={String(value)}
                  onChange={(e) =>
                    answer(
                      f.id,
                      f.type === "Numeric" && e.target.value !== ""
                        ? Number(e.target.value)
                        : e.target.value,
                    )
                  }
                />
              )}
            </QuestionField>
          );
        })}
        {data.waivers.length > 0 && (
          <>
            <h3>
              {memberOrg
                ? "Review and accept waivers"
                : "Waiver acceptance received"}
            </h3>
            <p>
              {memberOrg
                ? "Read each document before accepting it for yourself or your child."
                : "Record an acceptance already received from the participant or their adult family supervisor."}
            </p>
            {!adults.length && (
              <p className="info-box">
                No eligible adult signer is available. Add an active adult
                supervisor to this member’s family account, or check the adult
                participant’s birth date, then reopen registration.
              </p>
            )}
          </>
        )}
        {data.waivers.map((w) => {
          const acceptance = values.waiver_acceptances.find(
            (a) => a.waiver_id === w.id,
          );
          return (
            <section className="registration-waiver" key={w.id}>
              <details>
                <summary>
                  {w.name} · Version {w.version}
                  {w.required ? " · Required" : ""}
                </summary>
                <div className="waiver-document">
                  <HtmlContent html={w.content} />
                </div>
              </details>
              <Check
                required={w.required}
                checked={!!acceptance}
                onChange={(e) =>
                  update({
                    ...values,
                    waiver_acceptances: e.target.checked
                      ? [
                          ...values.waiver_acceptances,
                          {
                            waiver_id: w.id,
                            waiver_version: w.version,
                            signer_id: memberOrg ? adults[0]?.id || "" : "",
                          },
                        ]
                      : values.waiver_acceptances.filter(
                          (a) => a.waiver_id !== w.id,
                        ),
                  })
                }
              >
                {memberOrg
                  ? "I have read and accept"
                  : "Acceptance received for"}{" "}
                {w.name}
              </Check>
              {acceptance && !memberOrg && (
                <Field label={`Signer for ${w.name}`} required>
                  <Select
                    required
                    options={[
                      { value: "", label: "Select the adult who accepted" },
                      ...adults.map((p) => ({
                        value: p.id,
                        label: p.name,
                      })),
                    ]}
                    value={acceptance.signer_id}
                    onChange={(e) =>
                      update({
                        ...values,
                        waiver_acceptances: values.waiver_acceptances.map(
                          (a) =>
                            a.waiver_id === w.id
                              ? { ...a, signer_id: e.target.value }
                              : a,
                        ),
                      })
                    }
                  />
                </Field>
              )}
            </section>
          );
        })}
      </fieldset>
    </section>
  );
}
function QuestionField({
  field: f,
  children,
}: {
  field: CustomField;
  children: ReactNode;
}) {
  return f.type === "Multiple Checkboxes" ? (
    <fieldset className="field question-checkbox-group">
      <legend>
        {f.name}
        {f.required && <b className="required"> *</b>}
      </legend>
      {children}
    </fieldset>
  ) : (
    <Field
      label={f.name}
      required={f.required}
      hint={f.managed_by_staff ? "Managed by staff" : undefined}
    >
      {children}
    </Field>
  );
}

export function ProfileAnswerRecord({ personId }: { personId: string }) {
  const { data, loading, error } = useData<{
    revisions: {
      version: number;
      definition: FormDefinition;
      answers: RegistrationFormValues["answers"];
      created_at: string;
    }[];
  }>(`/people/${personId}/profile-answers`, { revisions: [] });
  const [version, setVersion] = useState(0);
  const record =
    data.revisions.find((r) => r.version === version) || data.revisions[0];
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!record) return null;
  return (
    <section className="profile-answer-record">
      <h2>Profile questions</h2>
      {data.revisions.length > 1 && (
        <Field label="Answer history">
          <Select
            value={version || record.version}
            onChange={(e) => setVersion(+e.target.value)}
            options={data.revisions.map((r, i) => ({
              value: String(r.version),
              label: `${i === 0 ? "Current · " : ""}Revision ${r.version} · ${new Date(r.created_at).toLocaleString()}`,
            }))}
          />
        </Field>
      )}
      <dl className="answer-record">
        {record.definition.fields.map((f) => {
          const value = record.answers[f.id];
          return (
            <div key={f.id}>
              <dt>{f.name}</dt>
              <dd>
                {value === undefined ? (
                  "Not provided"
                ) : f.type === "File Upload" ? (
                  <a href={`/api/form-files/${value}`}>Download attachment</a>
                ) : Array.isArray(value) ? (
                  value.join(", ")
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
export function RegistrationRecord({
  registrationId,
  onClose = () => {},
  inline = false,
}: {
  registrationId: string;
  onClose?: () => void;
  inline?: boolean;
}) {
  const { data, loading, error, reload } = useData<{
    definition: FormDefinition;
    answers: Record<string, string | number | string[]>;
    waivers: {
      id: string;
      document: Waiver;
      method: string;
      first_name: string;
      last_name: string;
      accepted_at: string;
      recorded_at: string;
    }[];
  }>(`/registrations/${registrationId}/form`, {
    definition: blankDefinition,
    answers: {},
    waivers: [],
  });
  const content = (
      <div className="modal-body">
        <ErrorBox error={error} />
        {loading ? (
          <Loading />
        ) : error ? (
          <Button type="button" secondary onClick={reload}>Retry loading records</Button>
        ) : (
          <>
            <h3>Submitted answers</h3>
            {data.definition.fields.length ? (
              <dl className="answer-record">
                {data.definition.fields.map((f) => {
                  const value = data.answers[f.id];
                  return (
                    <div key={f.id}>
                      <dt>{f.name}</dt>
                      <dd>
                        {value === undefined ? (
                          "Not provided"
                        ) : f.type === "File Upload" ? (
                          <a href={`/api/form-files/${value}`}>
                            Download attachment
                          </a>
                        ) : Array.isArray(value) ? (
                          value.join(", ")
                        ) : (
                          String(value)
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p>No custom answers were recorded for this registration.</p>
            )}
            <h3>Waiver records</h3>
            {data.waivers.length ? (
              data.waivers.map((w) => (
                <section className="registration-waiver" key={w.id}>
                  <h4>
                    {w.document.name} · Version {w.document.version}
                  </h4>
                  <p>
                    Signer:{" "}
                    <strong>
                      {w.first_name} {w.last_name}
                    </strong>
                  </p>
                  <p>
                    {w.method} · Acceptance received{" "}
                    {new Date(w.accepted_at).toLocaleString()}
                    <br />
                    Record created {new Date(w.recorded_at).toLocaleString()}
                  </p>
                  <details>
                    <summary>View retained document</summary>
                    <div className="waiver-document">
                      <HtmlContent html={w.document.content} />
                    </div>
                  </details>
                </section>
              ))
            ) : (
              <p>
                No document-level acceptance record is available. Older
                registrations may contain a legacy acceptance flag.
              </p>
            )}
          </>
        )}
      </div>
  );
  return inline ? content : <Modal wide title="Registration form and waivers" onClose={onClose}>{content}</Modal>;
}

export function RegistrationTabs({
  programId,
  active,
}: {
  programId?: string;
  active: string;
}) {
  return (
    <nav
      className="settings-section-tabs"
      aria-label="Registration settings sections"
    >
      {[
        [
          "Options",
          programId
            ? `/programs/${programId}/options`
            : "/settings/registration",
        ],
        [
          "Form Fields",
          programId
            ? `/programs/${programId}/form-fields`
            : "/settings/registration/fields",
        ],
        [
          "Waivers",
          programId
            ? `/programs/${programId}/waivers`
            : "/settings/registration/waivers",
        ],
      ].map(([label, path]) => (
        <Link
          key={label}
          className={active === label ? "active" : ""}
          to={path}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function FormSettings({
  waivers = false,
  profile = false,
}: {
  waivers?: boolean;
  profile?: boolean;
}) {
  const { id } = useParams(),
    scope = profile ? "profile" : id ? `program:${id}` : "site",
    { data, loading, error } = useData<FormDefinition>(
      `/forms/${scope}`,
      blankDefinition,
    );
  return (
    <>
      <PageTitle
        title={
          profile
            ? "Member Profile Properties"
            : waivers
              ? "Registration Waivers"
              : "Registration Form Fields"
        }
      />
      {id && <ProgramNav id={id} active="Settings" />}
      {!profile && (
        <RegistrationTabs
          programId={id}
          active={waivers ? "Waivers" : "Form Fields"}
        />
      )}
      <main className="content-page">
        {profile && <MemberPropertySettings />}
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : (
          <DefinitionEditor
            key={scope + String(waivers)}
            initial={data}
            scope={scope}
            waiverMode={waivers}
            profile={profile}
          />
        )}
      </main>
    </>
  );
}
function DefinitionEditor({
  initial,
  scope,
  waiverMode,
  profile,
}: {
  initial: FormDefinition;
  scope: string;
  waiverMode: boolean;
  profile: boolean;
}) {
  const [form, setForm] = useState(initial),
    [field, setField] = useState<CustomField | null>(null),
    [waiver, setWaiver] = useState<Waiver | null>(null),
    [removing, setRemoving] = useState<{ id: string; name: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const persist = async (next: FormDefinition) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<FormDefinition>(`/forms/${scope}`, {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setForm(result);
      setSaved(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const changeField = (id: string, patch: Partial<CustomField>) => {
    setSaved(false);
    setForm((old) => ({
      ...old,
      fields: old.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
  };
  const changeWaiver = (id: string, patch: Partial<Waiver>) => {
    setSaved(false);
    setForm((old) => ({
      ...old,
      waivers: old.waivers.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));
  };
  return (
    <>
      <ErrorBox error={error} />
      {saved && (
        <p className="success-box" role="status">
          Settings saved.
        </p>
      )}
      {scope === "site" && (
        <p className="info-box">
          These defaults are copied into newly created programs. Existing
          programs keep their own fields and waivers.
        </p>
      )}
      {profile && (
        <p className="info-box">
          Profile questions are separate from program registration questions.
        </p>
      )}
      <div className="website-columns">
        <section>
          {waiverMode ? (
            <>
              <div className="website-list-actions">
                <h2>Waiver documents</h2>
                <Button
                  onClick={() =>
                    setWaiver({
                      ...newWaiver(),
                      order: form.waivers.length + 1,
                    })
                  }
                >
                  <Plus size={14} /> Add Another Waiver
                </Button>
              </div>
              <DataTable
                rows={[...form.waivers].sort((a, b) => a.order - b.order)}
                columns={[
                  {
                    key: "order",
                    label: "Order",
                    render: (w) => (
                      <input
                        className="order-input"
                        type="number"
                        min={0}
                        max={10000}
                        aria-label={`Order for ${w.name}`}
                        value={w.order}
                        onChange={(e) =>
                          changeWaiver(w.id, { order: +e.target.value })
                        }
                      />
                    ),
                  },
                  {
                    key: "name",
                    label: "Waiver",
                    className: "form-question-column",
                    render: (w) => (
                      <>
                        <button
                          className="text-button"
                          onClick={() => setWaiver(w)}
                        >
                          {w.name}
                        </button>
                        <small className="cell-sub">
                          {w.kind} · Version {w.version} · {w.apply}
                        </small>
                        <small className="cell-sub">
                          {w.required ? "Required" : "Optional"} ·{" "}
                          {w.enabled ? "Enabled" : "Disabled"}
                        </small>
                      </>
                    ),
                  },
                  ...roleOptions.map((role) => ({
                    key: role,
                    label: role,
                    render: (w: Waiver) => (
                      <input
                        type="checkbox"
                        aria-label={`${w.name}: ${role}`}
                        checked={w.roles.includes(role)}
                        onChange={(e) =>
                          changeWaiver(w.id, {
                            roles: e.target.checked
                              ? [...w.roles, role]
                              : w.roles.filter((r) => r !== role),
                          })
                        }
                      />
                    ),
                  })),
                  {
                    key: "actions",
                    label: "Actions",
                    render: (w) => (
                      <div className="row-actions">
                        <button
                          className="square-action"
                          aria-label={`Edit ${w.name}`}
                          onClick={() => setWaiver(w)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="square-action"
                          aria-label={`Remove ${w.name}`}
                          onClick={() => setRemoving(w)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ),
                  },
                ]}
              />
            </>
          ) : (
            <>
              <div className="website-list-actions">
                <h2>Custom Form Fields</h2>
                <Button
                  onClick={() =>
                    setField({ ...newField(), order: form.fields.length + 1 })
                  }
                >
                  <Plus size={14} /> Add Form Field
                </Button>
              </div>
              <DataTable
                rows={[...form.fields].sort((a, b) => a.order - b.order)}
                columns={[
                  {
                    key: "order",
                    label: "Order",
                    render: (f) => (
                      <input
                        className="order-input"
                        type="number"
                        min={0}
                        max={10000}
                        aria-label={`Order for ${f.name}`}
                        value={f.order}
                        onChange={(e) =>
                          changeField(f.id, { order: +e.target.value })
                        }
                      />
                    ),
                  },
                  {
                    key: "name",
                    label: "Field",
                    className: "form-question-column",
                    render: (f) => (
                      <>
                        <button
                          className="text-button"
                          onClick={() => setField(f)}
                        >
                          {f.name}
                        </button>
                        <small className="cell-sub">
                          {f.required ? "Required" : "Optional"} · {f.type} ·{" "}
                          {f.visibility} · {f.apply}
                        </small>
                        {f.options.length > 0 && (
                          <ul className="form-option-list">
                            {f.options.map((o) => (
                              <li key={o}>{o}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    ),
                  },
                  ...(!profile
                    ? roleOptions.map((role) => ({
                        key: role,
                        label: role,
                        render: (f: CustomField) => (
                          <input
                            type="checkbox"
                            aria-label={`${f.name}: ${role}`}
                            checked={f.roles.includes(role)}
                            onChange={(e) =>
                              changeField(f.id, {
                                roles: e.target.checked
                                  ? [...f.roles, role]
                                  : f.roles.filter((r) => r !== role),
                              })
                            }
                          />
                        ),
                      }))
                    : []),
                  ...(!profile
                    ? [
                        {
                          key: "roster",
                          label: "Required for Roster",
                          render: (f: CustomField) => (
                            <input
                              type="checkbox"
                              aria-label={`Roster requires ${f.name}`}
                              checked={f.roster_required}
                              onChange={(e) =>
                                changeField(f.id, {
                                  roster_required: e.target.checked,
                                })
                              }
                            />
                          ),
                        },
                        {
                          key: "managed",
                          label: "Managed by Staff",
                          render: (f: CustomField) => (
                            <input
                              type="checkbox"
                              aria-label={`Staff manages ${f.name}`}
                              checked={f.managed_by_staff}
                              onChange={(e) =>
                                changeField(f.id, {
                                  managed_by_staff: e.target.checked,
                                })
                              }
                            />
                          ),
                        },
                      ]
                    : []),
                  {
                    key: "actions",
                    label: "Actions",
                    render: (f) => (
                      <div className="row-actions">
                        <button
                          className="square-action"
                          aria-label={`Edit ${f.name}`}
                          onClick={() => setField(f)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="square-action"
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setRemoving(f)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ),
                  },
                ]}
              />
            </>
          )}
          <div className="form-actions">
            <Button disabled={busy} onClick={() => void persist(form)}>
              Update Order &amp; Assignments
            </Button>
          </div>
        </section>
        <aside className="website-help">
          <h3>{waiverMode ? "Waiver records" : "Form fields"}</h3>
          <p>
            {waiverMode
              ? "Each document version is retained with recorded acceptance. Updating a document does not replace a previous participant’s record."
              : "Choose the questions for your registration form and the participant roles that answer each question."}
          </p>
          <h3>Applicability</h3>
          <p>
            Questions and documents can apply to adults, children, or everyone.
          </p>
          {!waiverMode && (
            <>
              <h3>Visibility</h3>
              <p>
                Admin Only questions stay in the console. Fields managed by
                staff are omitted from member registration.
              </p>
            </>
          )}
        </aside>
      </div>
      {field && (
        <FieldEditor
          field={field}
          profile={profile}
          busy={busy}
          error={error}
          cancel={() => setField(null)}
          save={async (value) => {
            if (
              await persist({
                ...form,
                fields: form.fields.some((f) => f.id === value.id)
                  ? form.fields.map((f) => (f.id === value.id ? value : f))
                  : [...form.fields, value],
              })
            )
              setField(null);
          }}
        />
      )}
      {waiver && (
        <WaiverEditor
          waiver={waiver}
          busy={busy}
          error={error}
          cancel={() => setWaiver(null)}
          save={async (value) => {
            if (
              await persist({
                ...form,
                waivers: form.waivers.some((w) => w.id === value.id)
                  ? form.waivers.map((w) => (w.id === value.id ? value : w))
                  : [...form.waivers, value],
              })
            )
              setWaiver(null);
          }}
        />
      )}
      {removing && (
        <Modal
          title={waiverMode ? "Remove waiver" : "Remove field"}
          onClose={() => setRemoving(null)}
        >
          <div className="modal-body">
            <p>
              Remove “{removing.name}” from future submissions? Existing answers
              and acceptance records will be retained.
            </p>
            <ErrorBox error={error} />
            <div className="form-actions">
              <Button
                disabled={busy}
                onClick={async () => {
                  if (
                    await persist(
                      waiverMode
                        ? {
                            ...form,
                            waivers: form.waivers.filter(
                              (w) => w.id !== removing.id,
                            ),
                          }
                        : {
                            ...form,
                            fields: form.fields.filter(
                              (f) => f.id !== removing.id,
                            ),
                          },
                    )
                  )
                    setRemoving(null);
                }}
              >
                Remove
              </Button>
              <Button secondary onClick={() => setRemoving(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
function FieldEditor({
  field,
  profile,
  busy,
  error,
  cancel,
  save,
}: {
  field: CustomField;
  profile: boolean;
  busy: boolean;
  error: string;
  cancel: () => void;
  save: (field: CustomField) => Promise<void>;
}) {
  const [f, setF] = useState(field),
    [staffRoles, setStaffRoles] = useState(field.staff_roles.join(", ")),
    [options, setOptions] = useState(field.options.join("\n"));
  return (
    <Modal title="Form field" onClose={cancel}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            ...f,
            staff_roles: staffRoles
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
            options: ["Dropdown", "Multiple Checkboxes"].includes(f.type)
              ? options
                  .split("\n")
                  .map((o) => o.trim())
                  .filter(Boolean)
              : [],
          });
        }}
      >
        <ErrorBox error={error} />
        <Field label="Name" required>
          <input
            required
            maxLength={200}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
        <Field label="Tag">
          <input
            maxLength={80}
            value={f.tag}
            onChange={(e) => setF({ ...f, tag: e.target.value })}
          />
        </Field>
        <Field label="Type">
          <Select
            options={types}
            value={f.type}
            onChange={(e) => setF({ ...f, type: e.target.value })}
          />
        </Field>
        {["Dropdown", "Multiple Checkboxes"].includes(f.type) && (
          <Field label="Options" required hint="One option per line">
            <textarea
              rows={5}
              required
              value={options}
              onChange={(e) => setOptions(e.target.value)}
            />
          </Field>
        )}
        <div className="website-form-grid">
          <Field label="Priority">
            <Select
              options={["Required", "Optional"]}
              value={f.required ? "Required" : "Optional"}
              onChange={(e) =>
                setF({ ...f, required: e.target.value === "Required" })
              }
            />
          </Field>
          <Field label="Visibility">
            <Select
              options={["Public", "Protected", "Private", "Admin Only"]}
              value={f.visibility}
              onChange={(e) => setF({ ...f, visibility: e.target.value })}
            />
          </Field>
          <Field label="Apply">
            <Select
              options={["Always", "Adults", "Children"]}
              value={f.apply}
              onChange={(e) => setF({ ...f, apply: e.target.value })}
            />
          </Field>
        </div>
        {!profile && (
          <Field
            label="Program staff roles"
            hint="Leave blank for all staff roles, or enter names separated by commas."
          >
            <input
              value={staffRoles}
              onChange={(e) => setStaffRoles(e.target.value)}
            />
          </Field>
        )}
        <div className="form-actions">
          <Button disabled={busy}>Save field</Button>
          <Button type="button" secondary onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function WaiverEditor({
  waiver,
  busy,
  error,
  cancel,
  save,
}: {
  waiver: Waiver;
  busy: boolean;
  error: string;
  cancel: () => void;
  save: (waiver: Waiver) => Promise<void>;
}) {
  const [w, setW] = useState(waiver),
    [staffRoles, setStaffRoles] = useState(waiver.staff_roles.join(", ")),
    [preview, setPreview] = useState(false);
  return (
    <Modal wide title="Waiver document" onClose={cancel}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            ...w,
            staff_roles: staffRoles
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          });
        }}
      >
        <ErrorBox error={error} />
        <Field label="Name" required>
          <input
            required
            maxLength={160}
            value={w.name}
            onChange={(e) => setW({ ...w, name: e.target.value })}
          />
        </Field>
        <div className="website-form-grid">
          <Field label="Document type">
            <Select
              options={["Main Waiver", "Payment Policy", "Additional Waiver"]}
              value={w.kind}
              onChange={(e) => setW({ ...w, kind: e.target.value })}
            />
          </Field>
          <Field label="Apply">
            <Select
              options={["Always", "Adults", "Children"]}
              value={w.apply}
              onChange={(e) => setW({ ...w, apply: e.target.value })}
            />
          </Field>
        </div>
        <Check
          checked={w.enabled}
          onChange={(e) => setW({ ...w, enabled: e.target.checked })}
        >
          Enabled
        </Check>
        <Check
          checked={w.required}
          onChange={(e) => setW({ ...w, required: e.target.checked })}
        >
          Acceptance required
        </Check>
        <RichText
          label="Waiver content"
          maxLength={100000}
          value={w.content}
          onChange={(content) => setW({ ...w, content })}
        />
        <Field
          label="Program staff roles"
          hint="Leave blank for all staff roles, or enter names separated by commas."
        >
          <input
            value={staffRoles}
            onChange={(e) => setStaffRoles(e.target.value)}
          />
        </Field>
        <Button type="button" secondary onClick={() => setPreview(!preview)}>
          {preview ? "Hide document preview" : "Preview document"}
        </Button>
        {preview && (
          <div className="waiver-document">
            <h2>{w.name}</h2>
            <HtmlContent html={w.content} />
          </div>
        )}
        <div className="form-actions">
          <Button disabled={busy}>Save waiver</Button>
          <Button type="button" secondary onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
