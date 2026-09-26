import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import {
  Button,
  Check,
  ErrorBox,
  Field,
  Loading,
  PageTitle,
  Tabs,
  useData,
} from "./components";

export type TermField = {
  key: string;
  label: string;
  enabled: boolean;
  required_types: string[];
  options: { id: string; label: string }[];
};
export type Terminology = { version: number; fields: TermField[] };
const types = ["League", "Event", "Tournament", "Camp", "Club team", "Class"];
export const useTerminology = () =>
  useData<Terminology | null>("/terminology", null);
export function termChoices(field: TermField, current = "") {
  const labels = field.options.map((o) => o.label);
  return current && !labels.includes(current) ? [current, ...labels] : labels;
}

export function TerminologySettings() {
  const { data, error, loading, reload } = useTerminology();
  const [tab, setTab] = useState("Terminology Settings");
  const [notice, setNotice] = useState("");
  return (
    <>
      <PageTitle title="Terminology" />
      <main className="legacy-page terminology-page">
        <Tabs
          items={["Terminology Settings", "Terminology Options"]}
          value={tab}
          onChange={(next) => {
            setTab(next);
            setNotice("");
          }}
        />
        <ErrorBox error={error} />
        {notice && <p role="status">{notice}</p>}
        {loading ? (
          <Loading />
        ) : (
          data && (
            <TermEditor
              key={data.version + tab}
              initial={data}
              options={tab === "Terminology Options"}
              saving={() => setNotice("")}
              saved={() => {
                setNotice("Changes saved.");
                reload();
              }}
            />
          )
        )}
      </main>
    </>
  );
}
function TermEditor({
  initial,
  options,
  saved,
  saving: onSaving,
}: {
  initial: Terminology;
  options: boolean;
  saved: () => void;
  saving: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(next: Terminology) {
    setError("");
    setSaving(true);
    onSaving();
    try {
      const result = await api<Terminology>("/terminology", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setForm(result);
      saved();
      return true;
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return false;
    } finally {
      setSaving(false);
    }
  }
  const change = (key: string, patch: Partial<TermField>) =>
    setForm((old) => ({
      ...old,
      fields: old.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    }));
  return (
    <>
      <ErrorBox error={error} />
      {options ? (
        <>
          <p>
            Choose the values available in program editors. Renaming an option
            updates programs using it. An option in use must be replaced in
            those programs before removal.
          </p>
          {form.fields.map((field) => (
            <TermOptions
              key={field.key + form.version}
              field={field}
              disabled={saving}
              save={(next) =>
                save({
                  ...form,
                  fields: form.fields.map((f) =>
                    f.key === field.key ? next : f,
                  ),
                })
              }
            />
          ))}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(form);
          }}
        >
          <fieldset disabled={saving} className="terminology-fields">
            {form.fields.map((field, i) => (
              <section key={field.key}>
                <Field
                  label={
                    i === 0
                      ? "Season Label"
                      : i === 1
                        ? "Experience Level Label"
                        : `Accounting Code ${i - 1} Label`
                  }
                  required
                >
                  <input
                    required
                    maxLength={80}
                    value={field.label}
                    onChange={(e) =>
                      change(field.key, { label: e.target.value })
                    }
                  />
                </Field>
                {i < 2 ? (
                  <fieldset className="term-requirements">
                    <legend>Require {field.label || "this field"} for:</legend>
                    {types.map((type) => (
                      <Check
                        key={type}
                        checked={field.required_types.includes(type)}
                        onChange={(e) =>
                          change(field.key, {
                            required_types: e.target.checked
                              ? [...field.required_types, type]
                              : field.required_types.filter((t) => t !== type),
                          })
                        }
                      >
                        {type}
                      </Check>
                    ))}
                  </fieldset>
                ) : (
                  <Check
                    checked={field.enabled}
                    onChange={(e) =>
                      change(field.key, { enabled: e.target.checked })
                    }
                  >
                    Enable {field.label || `accounting code ${i - 1}`}
                  </Check>
                )}
              </section>
            ))}
          </fieldset>
          <div className="form-actions">
            <Link to="/programs">Cancel</Link>
            <Button disabled={saving}>
              {saving ? "Saving…" : "Save Preferences"}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
function TermOptions({
  field,
  disabled,
  save,
}: {
  field: TermField;
  disabled: boolean;
  save: (field: TermField) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <section className="term-options">
      <h2>
        {field.label}
        {!field.enabled && <small> · Disabled</small>}
      </h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {field.options.map((option) => (
            <tr key={option.id}>
              <td>{option.label}</td>
              <td>
                {removing === option.id ? (
                  <span className="inline">
                    Remove this option?{" "}
                    <Button
                      secondary
                      disabled={disabled}
                      onClick={() =>
                        void save({
                          ...field,
                          options: field.options.filter(
                            (o) => o.id !== option.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                    <Button secondary onClick={() => setRemoving(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <span className="inline">
                    <button
                      className="text-button"
                      disabled={disabled}
                      onClick={() => {
                        setEditing(option.id);
                        setLabel(option.label);
                        setRemoving(null);
                      }}
                      aria-label={`Edit ${field.label} option ${option.label}`}
                    >
                      edit
                    </button>
                    <button
                      className="text-button"
                      disabled={disabled}
                      onClick={() => setRemoving(option.id)}
                      aria-label={`Remove ${field.label} option ${option.label}`}
                    >
                      delete
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
          {!field.options.length && (
            <tr>
              <td colSpan={2}>No options yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      {editing !== null ? (
        <form
          className="term-option-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const option = { id: editing || crypto.randomUUID(), label };
            const next = editing
              ? field.options.map((o) => (o.id === editing ? option : o))
              : [...field.options, option];
            if (await save({ ...field, options: next })) {
              setEditing(null);
              setLabel("");
            }
          }}
        >
          <Field label={`${field.label} option label`} required>
            <input
              required
              autoFocus
              disabled={disabled}
              maxLength={100}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Button disabled={disabled}>Save Item</Button>
          <Button
            secondary
            type="button"
            disabled={disabled}
            onClick={() => setEditing(null)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <button
          className="text-button"
          disabled={disabled}
          onClick={() => {
            setEditing("");
            setLabel("");
            setRemoving(null);
          }}
        >
          + Add {field.label} item
        </button>
      )}
    </section>
  );
}
