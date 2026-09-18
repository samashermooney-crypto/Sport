import { useState } from "react";
import { api, money, shortDate } from "./api";
import {
  Button,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
  Select,
  useData,
} from "./components";
export type InvoicePlan = {
  name: string;
  plan_id: string;
  plan_version: number;
  total_cents: number;
  voided?: boolean;
  installments: {
    position: number;
    due_date: string;
    amount_cents: number;
    fee_cents: number;
    discount_cents?: number;
    total_cents: number;
    paid_cents: number;
    balance_cents: number;
  }[];
};
export function InstallmentBreakdown({ plan }: { plan: InvoicePlan }) {
  return (
    <section className="installment-breakdown">
      <h3>Payment Plan: {plan.name}</h3>
      <DataTable
        rows={plan.installments.map((row) => ({
          ...row,
          id: String(row.position),
        }))}
        columns={[
          { key: "position", label: "Installment", render: (r) => r.position },
          {
            key: "due_date",
            label: "Due date",
            render: (r) => shortDate(r.due_date),
          },
          {
            key: "amount_cents",
            label: "Amount",
            render: (r) => money(r.amount_cents),
          },
          {
            key: "fee_cents",
            label: "Fees",
            render: (r) => money(r.fee_cents),
          },
          ...(plan.installments.some((row) => row.discount_cents)
            ? [
                {
                  key: "discount_cents",
                  label: "Discount",
                  render: (row: InvoicePlan["installments"][number]) =>
                    money(row.discount_cents || 0),
                },
              ]
            : []),
          {
            key: "total_cents",
            label: "Total",
            render: (r) => money(r.total_cents),
          },
          {
            key: "paid_cents",
            label: "Paid",
            render: (r) => money(r.paid_cents),
          },
          {
            key: "balance_cents",
            label: "Balance",
            render: (r) => money(r.balance_cents),
          },
        ]}
      />
    </section>
  );
}
type Template = {
  id: string;
  version: number;
  name: string;
  role: string;
  fee_type: string;
  fee_value: number;
  require_autopay: boolean;
  installments: { due_date: string; amount_cents: number; fee_cents: number }[];
};
export function ConvertInvoicePlan({
  invoiceId,
  programId,
  total,
  close,
  saved,
}: {
  invoiceId: string;
  programId: string;
  total: number;
  close: () => void;
  saved: () => void;
}) {
  const plans = useData<{ plans: Template[] }>(
    "/programs/" + programId + "/payment-plans",
    { plans: [] },
  );
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const plan = plans.data.plans.find((p) => p.id === selected);
  const preview: InvoicePlan | null = plan
    ? {
        name: plan.name,
        plan_id: plan.id,
        plan_version: plan.version,
        total_cents: 0,
        installments: plan.installments.map((row, index) => {
          const fee =
            row.fee_cents +
            (plan.fee_type === "Fixed"
              ? plan.fee_value
              : Math.round((row.amount_cents * plan.fee_value) / 10000));
          return {
            ...row,
            position: index + 1,
            fee_cents: fee,
            total_cents: row.amount_cents + fee,
            paid_cents: 0,
            balance_cents: row.amount_cents + fee,
          };
        }),
      }
    : null;
  const planTotal = preview?.installments.reduce(
    (sum, r) => sum + r.total_cents,
    0,
  );
  async function convert() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      await api("/invoices/" + invoiceId + "/payment-plan", {
        method: "POST",
        body: JSON.stringify({ plan_id: plan.id, plan_version: plan.version }),
      });
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title="Convert to Payment Plan"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <ErrorBox error={error || plans.error} />
      {plans.loading ? (
        <Loading />
      ) : (
        <>
          <p>
            Select a plan for this {money(total)} invoice. Review the dates and
            amounts before converting.
          </p>
          <Field label="Payment plan">
            <Select
              disabled={busy}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              options={[
                { value: "", label: "Select payment plan" },
                ...plans.data.plans.map((p) => ({
                  value: p.id,
                  label: p.name + " · " + p.role,
                })),
              ]}
            />
          </Field>
          {!plans.data.plans.length && (
            <p>No payment plans have been configured for this program.</p>
          )}
          {preview && (
            <>
              <InstallmentBreakdown plan={preview} />
              <p>Plan total: {money(planTotal)}</p>
              {planTotal !== total && (
                <p className="error-box">
                  The plan total must match the invoice total.
                </p>
              )}
              {plan?.require_autopay && (
                <p className="error-box">
                  This plan requires Auto Pay enrollment, which is not available
                  yet.
                </p>
              )}
            </>
          )}
          <div className="modal-actions">
            <Button
              disabled={
                busy || !plan || planTotal !== total || plan.require_autopay
              }
              onClick={convert}
            >
              {busy ? "Converting…" : "Convert Invoice"}
            </Button>
            <Button secondary disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
