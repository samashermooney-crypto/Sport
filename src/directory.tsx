import { useCallback, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, csv, money, shortDate } from "./api";
import {
  Button,
  DateInput,
  Check,
  DataTable,
  ErrorBox,
  ExportButton,
  Field,
  Loading,
  Modal,
  PageTitle,
  SearchBox,
  Select,
  useData,
} from "./components";
import { memberName } from "./members";
import type {
  Credit,
  Discount,
  Invoice,
  Location,
  Person,
  Program,
} from "./types";

export function Locations() {
  const { data, loading, error, reload } = useData<Location[]>(
      "/locations",
      [],
    ),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [removing, setRemoving] = useState<Location | null>(null),
    [actionError, setActionError] = useState("");
  const close = useCallback(() => setRemoving(null), []);
  return (
    <>
      <PageTitle title="Locations" />
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="split-toolbar">
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
            }}
          >
            <SearchBox value={search} onChange={setSearch} />
            <Button>Apply</Button>
          </form>
          <Link className="button" to="/locations/new">
            Add a location
          </Link>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            pagination
            rows={data.filter(
              (l) =>
                !l.parent_id &&
                (
                  l.name +
                  " " +
                  l.city +
                  " " +
                  data
                    .filter((s) => s.parent_id === l.id)
                    .map((s) => s.name)
                    .join(" ")
                )
                  .toLowerCase()
                  .includes(query.toLowerCase()),
            )}
            columns={[
              {
                key: "name",
                label: "Name",
                sort: (l) => l.name,
                render: (l) => (
                  <>
                    <Link to={"/locations/" + l.id + "/edit"}>{l.name}</Link>
                    <small>
                      {data
                        .filter((s) => s.parent_id === l.id)
                        .map((s) => s.name)
                        .join(", ") || "(no sub-locations)"}
                    </small>
                  </>
                ),
              },
              { key: "city", label: "City" },
              { key: "state", label: "State/Province" },
              {
                key: "actions",
                label: "Actions",
                render: (l) => (
                  <div className="row-actions">
                    <Link
                      className="square-action"
                      aria-label={"Edit " + l.name}
                      to={"/locations/" + l.id + "/edit"}
                    >
                      <Pencil size={13} />
                    </Link>
                    <button
                      className="square-action"
                      aria-label={"Delete " + l.name}
                      onClick={() => {
                        setActionError("");
                        setRemoving(l);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </main>
      {removing && (
        <Modal title="Delete Location" onClose={close}>
          <div className="modal-body">
            <p>
              Delete {removing.name}? Locations used by programs or schedules
              cannot be deleted.
            </p>
            <ErrorBox error={actionError} />
            <div className="form-actions">
              <Button secondary onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await api("/locations/" + removing.id, {
                      method: "DELETE",
                    });
                    reload();
                    close();
                  } catch (e) {
                    setActionError((e as Error).message);
                  }
                }}
              >
                Delete Location
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
export function LocationEditor() {
  const { id } = useParams();
  return (
    <>
      <PageTitle
        title={id ? "Edit Location and Sub-Locations" : "Create New Location"}
      />
      <main className="content-page">
        {id ? <LoadedLocationEditor id={id} /> : <LocationForm />}
      </main>
    </>
  );
}
function LoadedLocationEditor({ id }: { id: string }) {
  const { data, loading, error, reload } = useData<Location[]>(
      "/locations",
      [],
    ),
    current = data.find((l) => l.id === id);
  return loading ? (
    <Loading />
  ) : current ? (
    <>
      <LocationForm key={current.id} initial={current} done={reload} />
      <Sublocations
        parent={current}
        rows={data.filter((l) => l.parent_id === current.id)}
        reload={reload}
      />
    </>
  ) : (
    <ErrorBox error={error || "Location not found"} />
  );
}
function LocationForm({
  initial,
  parent,
  done,
  cancel,
}: {
  initial?: Location;
  parent?: Location;
  done?: () => void;
  cancel?: () => void;
}) {
  const navigate = useNavigate(),
    [form, setForm] = useState({
      name: initial?.name ?? "",
      description: initial?.description ?? "",
      address: initial?.address ?? "",
      address2: initial?.address2 ?? "",
      city: initial?.city ?? "",
      state: initial?.state ?? "",
      postal_code: initial?.postal_code ?? "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const field = (key: keyof typeof form, label: string) => (
    <Field label={label}>
      <input
        value={form[key]}
        maxLength={255}
        onChange={(e) => {
          setSaved(false);
          setForm({ ...form, [key]: e.target.value });
        }}
      />
    </Field>
  );
  return (
    <form
      className={parent ? "sublocation-form" : "location-form"}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const result = await api<Location>(
            "/locations" + (initial ? "/" + initial.id : ""),
            {
              method: initial ? "PUT" : "POST",
              body: JSON.stringify({
                ...form,
                parent_id: parent?.id ?? initial?.parent_id ?? null,
              }),
            },
          );
          setError("");
          setSaved(true);
          if (parent) done?.();
          else if (!initial) navigate("/locations/" + result.id + "/edit");
          else done?.();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      {!parent && <h2>Basic Details</h2>}
      <Field label={parent ? "Sublocation Name" : "Location Name"} required>
        <input
          required
          maxLength={150}
          value={form.name}
          onChange={(e) => {
            setSaved(false);
            setForm({ ...form, name: e.target.value });
          }}
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={parent ? 3 : 8}
          maxLength={parent ? 200 : 10000}
          value={form.description}
          onChange={(e) => {
            setSaved(false);
            setForm({ ...form, description: e.target.value });
          }}
        />
      </Field>
      {parent ? (
        <small>{200 - form.description.length} characters left</small>
      ) : (
        <>
          <p className="muted">Address fields are optional.</p>
          <div className="compact-address">
            {field("address", "Address 1")}
            {field("address2", "Address 2 (optional)")}
            <div className="form-grid three">
              {field("city", "City")}
              {field("state", "State / Province")}
              {field("postal_code", "Postal Code")}
            </div>
          </div>
        </>
      )}
      <div className="form-actions start">
        <Button disabled={busy}>
          {busy
            ? "Saving…"
            : parent
              ? "Save Sub Location"
              : initial
                ? "Save Location"
                : "Create Location"}
        </Button>
        <Button
          secondary
          type="button"
          onClick={() => (cancel ? cancel() : navigate("/locations"))}
        >
          Cancel
        </Button>
        {saved && !parent && (
          <span className="success-text" role="status">
            Location saved.
          </span>
        )}
      </div>
    </form>
  );
}
function Sublocations({
  parent,
  rows,
  reload,
}: {
  parent: Location;
  rows: Location[];
  reload: () => void;
}) {
  const [editing, setEditing] = useState<Location | "new" | null>(null),
    [removing, setRemoving] = useState<Location | null>(null),
    [error, setError] = useState("");
  const close = useCallback(() => setRemoving(null), []);
  return (
    <section className="sublocations">
      <h2>Sub Locations</h2>
      {editing ? (
        <LocationForm
          key={editing === "new" ? "new" : editing.id}
          parent={parent}
          initial={editing === "new" ? undefined : editing}
          done={() => {
            setEditing(null);
            reload();
          }}
          cancel={() => setEditing(null)}
        />
      ) : (
        <Button secondary onClick={() => setEditing("new")}>
          <Plus size={13} />
          Add a Sub Location…
        </Button>
      )}
      {rows.map((l) => (
        <div className="sublocation-row" key={l.id}>
          <div>
            <strong>{l.name}</strong>
            <small>{l.description}</small>
          </div>
          <div className="row-actions">
            <button
              className="square-action"
              aria-label={"Edit " + l.name}
              onClick={() => setEditing(l)}
            >
              <Pencil size={13} />
            </button>
            <button
              className="square-action"
              aria-label={"Delete " + l.name}
              onClick={() => {
                setError("");
                setRemoving(l);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
      {removing && (
        <Modal title="Delete Sub Location" onClose={close}>
          <div className="modal-body">
            <p>
              Delete {removing.name}? Scheduled or assigned sublocations cannot
              be deleted.
            </p>
            <ErrorBox error={error} />
            <div className="form-actions">
              <Button secondary onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await api("/locations/" + removing.id, {
                      method: "DELETE",
                    });
                    close();
                    reload();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Delete Sub Location
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function Discounts() {
  const { data, loading, error } = useData<Discount[]>("/discounts", []),
    [params] = useSearchParams();
  const programId = params.get("program_id");
  return (
    <>
      <PageTitle title="Discount Codes" />
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="toolbar">
          <Link
            className="button"
            to={
              "/discount-codes/new" +
              (programId ? "?program_id=" + programId : "")
            }
          >
            <Plus size={13} />
            Add a {programId ? "Program" : "Universal"} Discount Code
          </Link>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            pagination
            rows={data.filter((d) =>
              programId ? d.program_id === programId : !d.program_id,
            )}
            columns={[
              {
                key: "name",
                label: "Name",
                sort: (d) => d.name,
                render: (d) => (
                  <>
                    <strong>{d.name}</strong>
                    <small>{d.description}</small>
                    {!d.active && <small>Disabled</small>}
                  </>
                ),
              },
              {
                key: "code",
                label: "Code",
                className: "code-column",
                render: (d) => (
                  <button
                    title="Copy discount code"
                    className="text-button"
                    onClick={async (e) => {
                      const target = e.currentTarget;
                      try {
                        await navigator.clipboard.writeText(d.code);
                        target.title = "Copied";
                      } catch {
                        target.title = "Select and copy this code";
                      }
                    }}
                  >
                    {d.code}
                  </button>
                ),
              },
              {
                key: "value",
                label: "Value",
                render: (d) =>
                  d.kind === "Fixed"
                    ? money(d.value)
                    : (d.value / 100).toFixed(2) + " %",
              },
              {
                key: "created_at",
                label: "Created",
                render: (d) => shortDate(d.created_at),
              },
              {
                key: "expires",
                label: "Expires",
                render: (d) => shortDate(d.expires),
              },
              {
                key: "redeemed",
                label: "Redeemed",
                render: (d) =>
                  d.redeemed +
                  (d.redemption_limit !== null
                    ? " / " + d.redemption_limit
                    : ""),
              },
              {
                key: "multi_use",
                label: "Multi use",
                render: (d) => (d.multi_use ? "✓" : "—"),
              },
              {
                key: "actions",
                label: "Actions",
                render: (d) => (
                  <Link
                    className="square-action"
                    aria-label={"Edit " + d.name}
                    to={"/discount-codes/" + d.id + "/edit"}
                  >
                    <Pencil size={13} />
                  </Link>
                ),
              },
            ]}
          />
        )}
      </main>
    </>
  );
}
export function DiscountEditor() {
  const { id } = useParams();
  return (
    <>
      <PageTitle title={(id ? "Edit" : "Create") + " Discount Code"} />
      <main className="content-page">
        {id ? <LoadedDiscountEditor id={id} /> : <DiscountForm />}
      </main>
    </>
  );
}
function LoadedDiscountEditor({ id }: { id: string }) {
  const { data, loading, error } = useData<Discount | null>(
    "/discounts/" + id,
    null,
  );
  return loading ? (
    <Loading />
  ) : data ? (
    <DiscountForm initial={data} />
  ) : (
    <ErrorBox error={error} />
  );
}
function DiscountForm({ initial }: { initial?: Discount }) {
  const [params] = useSearchParams(),
    navigate = useNavigate(),
    { data: programs } = useData<Program[]>("/programs", []);
  const [form, setForm] = useState({
      name: initial?.name ?? "Northstar Youth Sports Discount Code",
      description: initial?.description ?? "",
      code: initial?.code ?? "",
      kind: initial?.kind ?? "Fixed",
      value: initial ? String(initial.value / 100) : "",
      expires: initial?.expires ?? "",
      redemption_limit:
        initial?.redemption_limit == null
          ? ""
          : String(initial.redemption_limit),
      multi_use: Boolean(initial?.multi_use),
      active: initial ? Boolean(initial.active) : true,
      program_id: initial?.program_id ?? params.get("program_id") ?? "",
    }),
    [availability, setAvailability] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="help-form-layout">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/discounts" + (initial ? "/" + initial.id : ""), {
              method: initial ? "PUT" : "POST",
              body: JSON.stringify({
                ...form,
                value: Math.round(Number(form.value) * 100),
                redemption_limit: form.redemption_limit
                  ? Number(form.redemption_limit)
                  : null,
                program_id: form.program_id || null,
              }),
            });
            navigate(
              "/discount-codes" +
                (form.program_id ? "?program_id=" + form.program_id : ""),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="notice">
          Universal discount codes work for any program. Choose a program to
          restrict a code to that program.
        </div>
        <ErrorBox error={error} />
        <Field label="Name" required>
          <input
            required
            maxLength={150}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field
          label="Description"
          hint={350 - form.description.length + " characters left"}
        >
          <textarea
            rows={3}
            maxLength={350}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <Field
          label="Code"
          hint="Leave empty to have your code auto-generated."
        >
          <input
            maxLength={64}
            value={form.code}
            onChange={(e) => {
              setForm({ ...form, code: e.target.value });
              setAvailability("");
            }}
          />
        </Field>
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            try {
              const r = await api<{ available: boolean }>(
                "/discounts/availability?code=" +
                  encodeURIComponent(form.code) +
                  "&exclude=" +
                  (initial?.id ?? ""),
              );
              setAvailability(
                r.available
                  ? "This code is available."
                  : "Choose a different code.",
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Check Availability
        </button>
        <span role="status" className="availability">
          {availability}
        </span>
        <div className="form-grid compact-fields">
          <Field label="Value" required>
            <input
              required
              type="number"
              min="0.01"
              max={form.kind === "Percentage" ? 100 : 1000000}
              step="0.01"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
            />
          </Field>
          <Field label="Discount Type">
            <Select
              options={[
                { value: "Fixed", label: "Dollars ($)" },
                { value: "Percentage", label: "Percent (%)" },
              ]}
              value={form.kind}
              onChange={(e) =>
                setForm({ ...form, kind: e.target.value as Discount["kind"] })
              }
            />
          </Field>
        </div>
        <div className="compact-fields">
          <Field label="Expires">
            <DateInput
              type="date"
              value={form.expires}
              onChange={(e) => setForm({ ...form, expires: e.target.value })}
            />
          </Field>
          <Field label="Redemption Limit">
            <input
              type="number"
              min="1"
              step="1"
              value={form.redemption_limit}
              onChange={(e) =>
                setForm({ ...form, redemption_limit: e.target.value })
              }
            />
          </Field>
        </div>
        <Field label="Applies to">
          <Select
            value={form.program_id}
            onChange={(e) => setForm({ ...form, program_id: e.target.value })}
            options={[
              { value: "", label: "All programs — Universal" },
              ...programs
                .filter((p) => !p.grouped)
                .map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Field>
        <Check
          checked={form.multi_use}
          onChange={(e) => setForm({ ...form, multi_use: e.target.checked })}
        >
          This discount code can be redeemed more than once by the same person.
        </Check>
        {initial && (
          <Check
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          >
            Active — allow this code at registration
          </Check>
        )}
        <div className="form-actions start">
          <Button disabled={busy}>Save</Button>
          <Link className="button secondary" to="/discount-codes">
            Cancel
          </Link>
        </div>
      </form>
      <aside>
        <h3>What are Discount Codes?</h3>
        <p>
          Discount codes allow you to create and manage discounts for your
          programs.
        </p>
        <p>
          Give the discount a fixed monetary or percentage value, optional
          expiry, and redemption limit.
        </p>
        <p>
          Codes are checked when a registration is submitted. Disabled and
          expired codes cannot be redeemed.
        </p>
      </aside>
    </div>
  );
}

export function Credits() {
  const [params] = useSearchParams(),
    personId = params.get("person_id"),
    { data, loading, error, reload } = useData<Credit[]>(
      "/credits" + (personId ? "?person_id=" + personId : ""),
      [],
    ),
    [adding, setAdding] = useState(false),
    [applying, setApplying] = useState<Credit | null>(null);
  const close = useCallback(() => setAdding(false), []),
    closeApply = useCallback(() => setApplying(null), []);
  return (
    <>
      <PageTitle title="Credits" />
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="split-toolbar">
          <Button onClick={() => setAdding(true)}>
            <Plus size={13} />
            Issue Credit
          </Button>
          <ExportButton
            onClick={() =>
              csv(
                "credits",
                [
                  "Member ID",
                  "Name",
                  "Description",
                  "Original Value",
                  "Available Value",
                  "Expires",
                ],
                data.map((c) => [
                  c.person_id,
                  memberName(c),
                  c.description,
                  (c.amount_cents / 100).toFixed(2),
                  (c.balance_cents / 100).toFixed(2),
                  c.expires,
                ]),
              )
            }
          />
        </div>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            pagination
            rows={data}
            columns={[
              { key: "person_id", label: "Member ID" },
              {
                key: "name",
                label: "Name",
                render: (c) => (
                  <Link to={"/members/" + c.person_id}>{memberName(c)}</Link>
                ),
              },
              { key: "description", label: "Description" },
              {
                key: "amount_cents",
                label: "Original Value",
                render: (c) => money(c.amount_cents),
              },
              {
                key: "balance_cents",
                label: "Value",
                render: (c) => money(c.balance_cents),
              },
              {
                key: "expires",
                label: "Expires",
                render: (c) => shortDate(c.expires),
              },
              {
                key: "actions",
                label: "Actions",
                render: (c) =>
                  c.balance_cents > 0 ? (
                    <Button secondary onClick={() => setApplying(c)}>
                      Apply to Invoice
                    </Button>
                  ) : (
                    <span>Used</span>
                  ),
              },
            ]}
          />
        )}
      </main>
      {adding && (
        <Modal title="Issue Member Credit" onClose={close}>
          <CreditForm
            personId={personId ?? ""}
            done={() => {
              close();
              reload();
            }}
            cancel={close}
          />
        </Modal>
      )}
      {applying && (
        <Modal title="Apply Credit to Invoice" onClose={closeApply}>
          <ApplyCreditForm
            credit={applying}
            done={() => {
              closeApply();
              reload();
            }}
            cancel={closeApply}
          />
        </Modal>
      )}
    </>
  );
}
function CreditForm({
  personId,
  done,
  cancel,
}: {
  personId: string;
  done: () => void;
  cancel: () => void;
}) {
  const { data: people } = useData<Person[]>("/people", []),
    [form, setForm] = useState({
      person_id: personId,
      amount: "",
      description: "",
      expires: "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/credits", {
            method: "POST",
            body: JSON.stringify({
              ...form,
              amount_cents: Math.round(Number(form.amount) * 100),
            }),
          });
          done();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <Field label="Member" required>
        <Select
          required
          value={form.person_id}
          onChange={(e) => setForm({ ...form, person_id: e.target.value })}
          options={[
            { value: "", label: "Choose a member" },
            ...people.map((p) => ({ value: p.id, label: memberName(p) })),
          ]}
        />
      </Field>
      <Field label="Credit Amount ($)" required>
        <input
          required
          type="number"
          min="0.01"
          step="0.01"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          maxLength={1000}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <Field label="Expires">
        <DateInput
          type="date"
          value={form.expires}
          onChange={(e) => setForm({ ...form, expires: e.target.value })}
        />
      </Field>
      <p>Credit can be applied to this member’s outstanding invoices.</p>
      <div className="form-actions">
        <Button secondary type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button disabled={busy}>Issue Credit</Button>
      </div>
    </form>
  );
}
function ApplyCreditForm({
  credit,
  done,
  cancel,
}: {
  credit: Credit;
  done: () => void;
  cancel: () => void;
}) {
  const { data: invoices } = useData<(Invoice & { person_id: string })[]>(
      "/invoices",
      [],
    ),
    [invoice, setInvoice] = useState(""),
    [amount, setAmount] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const eligible = invoices.filter(
    (i) =>
      i.person_id === credit.person_id &&
      !i.voided &&
      i.total_cents > i.paid_cents,
  );
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/invoices/" + invoice + "/credits", {
            method: "POST",
            body: JSON.stringify({
              credit_id: credit.id,
              amount_cents: Math.round(Number(amount) * 100),
              idempotency_key: key,
            }),
          });
          done();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <p>
        {memberName(credit)} has {money(credit.balance_cents)} available on this
        credit.
      </p>
      <Field label="Invoice" required>
        <Select
          required
          value={invoice}
          onChange={(e) => {
            setInvoice(e.target.value);
            const i = eligible.find((i) => i.id === e.target.value);
            setAmount(
              i
                ? (
                    Math.min(
                      credit.balance_cents,
                      i.total_cents - i.paid_cents,
                    ) / 100
                  ).toFixed(2)
                : "",
            );
            setKey(crypto.randomUUID());
          }}
          options={[
            { value: "", label: "Choose an invoice" },
            ...eligible.map((i) => ({
              value: i.id,
              label:
                "#" +
                i.number +
                " — " +
                i.description +
                " — " +
                money(i.total_cents - i.paid_cents),
            })),
          ]}
        />
      </Field>
      {!eligible.length && <p>No outstanding invoices for this member.</p>}
      <Field label="Amount ($)" required>
        <input
          type="number"
          min="0.01"
          max={credit.balance_cents / 100}
          step="0.01"
          required
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setKey(crypto.randomUUID());
          }}
        />
      </Field>
      <div className="form-actions">
        <Button secondary type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button disabled={busy || !invoice}>Apply Credit</Button>
      </div>
    </form>
  );
}
