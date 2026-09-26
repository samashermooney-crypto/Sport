import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, money } from "./api";
import {
  Button,
  Check,
  DataTable,
  DateInput,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  useData,
} from "./components";
import { ProgramNav } from "./programs";
type Installment = {
  due_date: string;
  amount_cents: number;
  fee_cents: number;
};
type Plan = {
  id: string;
  version?: number;
  name: string;
  role: string;
  require_first_payment: boolean;
  strictly_enforce_first_payment: boolean;
  require_autopay: boolean;
  private_code: string;
  redemption_limit: number | null;
  fee_type: string;
  fee_value: number;
  installments: Installment[];
};
const blank: Plan = {
  id: "",
  name: "",
  role: "Free Agent",
  require_first_payment: false,
  strictly_enforce_first_payment: false,
  require_autopay: false,
  private_code: "",
  redemption_limit: null,
  fee_type: "Fixed",
  fee_value: 0,
  installments: [],
};
function total(plan: Plan) {
  return plan.installments.reduce(
    (sum, i) =>
      sum +
      i.amount_cents +
      i.fee_cents +
      (plan.fee_type === "Fixed"
        ? plan.fee_value
        : Math.round((i.amount_cents * plan.fee_value) / 10000)),
    0,
  );
}
export function PaymentPlans() {
  const { id } = useParams();
  const view = useData<{ version: number; plans: Plan[] }>(
    "/programs/" + id + "/payment-plans",
    { version: 1, plans: [] },
  );
  const [editing, setEditing] = useState<Plan | null>(null);
  const [version, setVersion] = useState(1);
  const [removing, setRemoving] = useState<{
    plan: Plan;
    version: number;
  } | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [removingBusy, setRemovingBusy] = useState(false);
  async function remove() {
    if (!removing) return;
    setRemovingBusy(true);
    setRemoveError("");
    try {
      await api("/programs/" + id + "/payment-plans/" + removing.plan.id, {
        method: "DELETE",
        body: JSON.stringify({ version: removing.version }),
      });
      setRemoving(null);
      view.reload();
    } catch (e) {
      setRemoveError((e as Error).message);
    } finally {
      setRemovingBusy(false);
    }
  }

  function edit(plan: Plan) {
    setVersion(view.data.version);
    setEditing(structuredClone(plan));
  }
  return (
    <>
      <PageTitle title="Payment Plans" />
      <ProgramNav id={id!} active="Settings" />
      <p>
        Configure payment-plan templates here. Enable payment plans in
        Registration Options to offer eligible plans to members. Plans requiring
        online payment or autopay are not available for enrollment yet.
      </p>
      <ErrorBox error={view.error} />
      <div className="split-toolbar">
        <h2>Payment Plans</h2>
        <Button
          onClick={() => edit(blank)}
          disabled={view.loading || !!view.error}
        >
          + Add Payment Plan
        </Button>
      </div>
      {view.loading ? (
        <Loading />
      ) : (
        <DataTable
          rows={view.data.plans}
          columns={[
            { key: "name", label: "Name", render: (p) => p.name },
            {
              key: "role",
              label: "Registration type",
              render: (p) => (p.role === "Free Agent" ? "Individual" : p.role),
            },
            {
              key: "installments",
              label: "Installments",
              render: (p) => p.installments.length,
            },
            { key: "total", label: "Total", render: (p) => money(total(p)) },
            {
              key: "actions",
              label: "Actions",
              render: (p) => (
                <div className="inline">
                  <Button secondary onClick={() => edit(p)}>
                    Edit
                  </Button>
                  <Button
                    secondary
                    onClick={() =>
                      edit({
                        ...p,
                        id: "",
                        version: undefined,
                        name: p.name + " (copy)",
                        private_code: "",
                        redemption_limit: null,
                      })
                    }
                  >
                    Copy
                  </Button>
                  <Button
                    secondary
                    onClick={() => {
                      setRemoveError("");
                      setRemoving({ plan: p, version: view.data.version });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      {removing && (
        <Modal
          title="Delete Payment Plan"
          onClose={() => {
            if (!removingBusy) setRemoving(null);
          }}
        >
          <p>
            Delete “{removing.plan.name}”? Existing invoice schedules will
            remain unchanged.
          </p>
          <ErrorBox error={removeError} />
          <div className="modal-actions">
            <Button disabled={removingBusy} onClick={remove}>
              {removingBusy ? "Deleting…" : "Delete Payment Plan"}
            </Button>
            <Button
              secondary
              disabled={removingBusy}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {editing && (
        <PlanEditor
          key={editing.id || "new"}
          initial={editing}
          programId={id!}
          version={version}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            view.reload();
          }}
        />
      )}
    </>
  );
}
function PlanEditor({
  initial,
  programId,
  version,
  close,
  saved,
}: {
  initial: Plan;
  programId: string;
  version: number;
  close: () => void;
  saved: () => void;
}) {
  const [form, setForm] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [step, setStep] = useState(initial.installments.length ? 2 : 1);
  const set = <K extends keyof Plan>(key: K, value: Plan[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  function change(
    index: number,
    key: keyof Installment,
    value: string | number,
  ) {
    set(
      "installments",
      form.installments.map((row, n) =>
        n === index ? { ...row, [key]: value } : row,
      ),
    );
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (step === 1) {
      setStep(2);
      return;
    }
    setBusy(true);
    try {
      await api(
        "/programs/" +
          programId +
          "/payment-plans" +
          (initial.id ? "/" + initial.id : ""),
        {
          method: initial.id ? "PUT" : "POST",
          body: JSON.stringify({ ...form, version }),
        },
      );
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial.id ? "Edit Payment Plan" : "Add Payment Plan"}
      wide
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <fieldset disabled={busy}>
          <Field label="Name" required>
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Type of role this payment plan is for">
            <Select
              options={[
                { value: "Free Agent", label: "Individual" },
                "Team Player",
                "Program Staff",
              ]}
              value={form.role}
              onChange={(e) => set("role", e.target.value)}
            />
          </Field>
          <Check
            checked={form.require_first_payment}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                require_first_payment: e.target.checked,
                strictly_enforce_first_payment:
                  e.target.checked && f.strictly_enforce_first_payment,
              }))
            }
          >
            Require first payment during registration
          </Check>
          <Check
            checked={form.strictly_enforce_first_payment}
            disabled={!form.require_first_payment}
            onChange={(e) =>
              set("strictly_enforce_first_payment", e.target.checked)
            }
          >
            Strictly enforce first payment during registration
          </Check>
          <Check
            checked={form.require_autopay}
            onChange={(e) => set("require_autopay", e.target.checked)}
          >
            Require Auto Pay enrollment
          </Check>
          <Field
            label="Private Plan Code"
            hint="Leave blank for a public plan."
          >
            <input
              maxLength={100}
              value={form.private_code}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  private_code: e.target.value,
                  redemption_limit: e.target.value ? f.redemption_limit : null,
                }))
              }
            />
          </Field>
          {form.private_code && (
            <Field label="Private Plan Redemption Limit">
              <input
                type="number"
                min={1}
                step={1}
                value={form.redemption_limit ?? ""}
                onChange={(e) =>
                  set(
                    "redemption_limit",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              />
            </Field>
          )}
          <div className="inline">
            <Field label="Processing fee">
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.fee_value / 100}
                onChange={(e) =>
                  set("fee_value", Math.round(Number(e.target.value) * 100))
                }
              />
            </Field>
            <Field label="Fee type">
              <Select
                options={[
                  { value: "Fixed", label: "Dollars per installment" },
                  { value: "Percentage", label: "Percent per installment" },
                ]}
                value={form.fee_type}
                onChange={(e) => set("fee_type", e.target.value)}
              />
            </Field>
          </div>
          {step === 2 && (
            <>
              <h3>Installments</h3>
              <p>
                Enter future payment dates in order. Changes apply to future
                registrations.
              </p>
              {form.installments.map((row, index) => (
                <div className="installment-editor" key={index}>
                  <Field label={"Amount due " + (index + 1)} required>
                    <input
                      type="number"
                      required
                      min={0}
                      step="0.01"
                      value={row.amount_cents / 100}
                      onChange={(e) =>
                        change(
                          index,
                          "amount_cents",
                          Math.round(Number(e.target.value) * 100),
                        )
                      }
                    />
                  </Field>
                  <Field label={"Due date " + (index + 1)} required>
                    <DateInput
                      type="date"
                      required
                      value={row.due_date}
                      onChange={(e) =>
                        change(index, "due_date", e.target.value)
                      }
                    />
                  </Field>
                  <Field label={"Additional fee " + (index + 1)}>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.fee_cents / 100}
                      onChange={(e) =>
                        change(
                          index,
                          "fee_cents",
                          Math.round(Number(e.target.value) * 100),
                        )
                      }
                    />
                  </Field>
                  <Button
                    type="button"
                    secondary
                    onClick={() =>
                      set(
                        "installments",
                        form.installments.filter((_, n) => n !== index),
                      )
                    }
                  >
                    Remove installment {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                secondary
                disabled={form.installments.length >= 120}
                onClick={() =>
                  set("installments", [
                    ...form.installments,
                    { due_date: "", amount_cents: 0, fee_cents: 0 },
                  ])
                }
              >
                Add an Installment
              </Button>
              <p>
                <strong>Total: {money(total(form))}</strong>
              </p>
            </>
          )}
          <div className="modal-actions">
            <Button
              disabled={busy || (step === 2 && !form.installments.length)}
            >
              {busy
                ? "Saving…"
                : step === 1
                  ? "Continue to Installments"
                  : "Save Payment Plan"}
            </Button>
            <Button type="button" secondary onClick={close}>
              Cancel
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
