import { InstallmentBreakdown, type InvoicePlan } from "./invoice-installments";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { money, shortDate } from "./api";
import {
  Button,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Tabs,
  useData,
} from "./components";
import { HtmlContent } from "./rich-text";
import type { CustomField, Waiver } from "./forms";

type Invoice = {
  id: string;
  number: number;
  participant_name: string;
  description: string;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  status: string;
  due_date: string;
  created_at: string;
};
type InvoiceDetail = Invoice & {
  payment_plan?: InvoicePlan | null;
  organization: { name: string; timezone: string };
  history: {
    id: string;
    amount_cents: number;
    type: string;
    method: string;
    created_at: string;
  }[];
};
export function MemberInvoices({ org }: { org: string }) {
  const { data, loading, error } = useData<Invoice[]>(
    `/member/${org}/invoices`,
    [],
  );
  const [status, setStatus] = useState("Outstanding"),
    [query, setQuery] = useState("");
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const rows = data.filter(
    (i) =>
      (status === "All" ||
        (status === "Outstanding"
          ? i.balance_cents > 0
          : i.status === status)) &&
      `${i.number} ${i.participant_name} ${i.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <h1>My invoices</h1>
      <Tabs
        items={[
          `Unpaid ${data.filter((i) => i.balance_cents > 0).length}`,
          `Receipts ${data.filter((i) => i.status === "Paid").length}`,
        ]}
        value={
          status === "Paid"
            ? `Receipts ${data.filter((i) => i.status === "Paid").length}`
            : `Unpaid ${data.filter((i) => i.balance_cents > 0).length}`
        }
        onChange={(value) =>
          setStatus(value.startsWith("Receipts") ? "Paid" : "Outstanding")
        }
      />
      <p className="member-balance">
        Total outstanding:{" "}
        <strong>
          {money(data.reduce((sum, i) => sum + i.balance_cents, 0))}
        </strong>
      </p>
      <div className="form-grid member-record-filters">
        <Field label="Invoice status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {[
              "All",
              "Outstanding",
              "Unpaid",
              "Partially paid",
              "Overdue",
              "Paid",
              "Void",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Search invoices">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
      </div>
      <DataTable
        rows={rows}
        pagination
        columns={[
          {
            key: "number",
            label: "Invoice",
            sort: (i) => i.number,
            render: (i) => (
              <Link to={`/site/${org}/account/invoice?id=${i.id}`}>
                #{i.number}
              </Link>
            ),
          },
          {
            key: "participant",
            label: "Participant",
            sort: (i) => i.participant_name,
            render: (i) => i.participant_name,
          },
          {
            key: "description",
            label: "Description",
            render: (i) => i.description,
          },
          {
            key: "due",
            label: "Due date",
            sort: (i) => i.due_date,
            render: (i) => shortDate(i.due_date),
          },
          {
            key: "total",
            label: "Total",
            sort: (i) => i.total_cents,
            render: (i) => money(i.total_cents),
          },
          {
            key: "balance",
            label: "Balance",
            sort: (i) => i.balance_cents,
            render: (i) => money(i.balance_cents),
          },
          {
            key: "status",
            label: "Status",
            sort: (i) => i.status,
            render: (i) => i.status,
          },
        ]}
      />
    </>
  );
}
export function MemberInvoice({ org }: { org: string }) {
  const [params] = useSearchParams(),
    invoiceId = params.get("id") || "";
  const { data, loading, error } = useData<InvoiceDetail | null>(
    `/member/${org}/invoices/${encodeURIComponent(invoiceId)}`,
    null,
  );
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error || "Invoice not found"} />;
  return (
    <article className="member-invoice">
      <div className="member-record-actions">
        <Link to={`/site/${org}/account/invoices`}>Back to invoices</Link>
        <Button type="button" secondary onClick={() => window.print()}>
          Print invoice
        </Button>
      </div>
      <h1>Invoice #{data.number}</h1>
      <p>{data.organization.name}</p>
      <dl className="member-record-summary">
        <div>
          <dt>Participant</dt>
          <dd>{data.participant_name}</dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>{shortDate(data.created_at)}</dd>
        </div>
        <div>
          <dt>Due date</dt>
          <dd>{shortDate(data.due_date)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{data.status}</dd>
        </div>
      </dl>
      <h2>{data.description}</h2>
      <dl className="member-record-summary">
        <div>
          <dt>Invoice total</dt>
          <dd>{money(data.total_cents)}</dd>
        </div>
        <div>
          <dt>Payments and credits applied</dt>
          <dd>{money(data.paid_cents)}</dd>
        </div>
        <div>
          <dt>Amount due</dt>
          <dd>
            <strong>{money(data.balance_cents)}</strong>
          </dd>
        </div>
      </dl>
      {data.payment_plan && <InstallmentBreakdown plan={data.payment_plan} />}
      {data.balance_cents > 0 && (
        <p className="info-box">
          Contact {data.organization.name} to arrange payment. This invoice
          remains outstanding until payment is recorded.
        </p>
      )}
      <h2>Payment history</h2>
      <DataTable
        rows={data.history}
        empty="No payments or credits have been recorded."
        columns={[
          {
            key: "date",
            label: "Date",
            render: (h) => shortDate(h.created_at),
          },
          {
            key: "type",
            label: "Type",
            render: (h) =>
              h.type === "credit"
                ? "Credit applied"
                : h.type === "refund"
                  ? "Refund"
                  : "Payment",
          },
          { key: "method", label: "Method", render: (h) => h.method },
          {
            key: "amount",
            label: "Amount",
            render: (h) => money(h.amount_cents),
          },
        ]}
      />
    </article>
  );
}
type RegistrationDetail = {
  id: string;
  program_name: string;
  participant_name: string;
  role: string;
  status: string;
  created_at: string;
  invoice_id: string | null;
  team_name: string | null;
  fields: CustomField[];
  answers: Record<string, string | number | string[]>;
  waivers: {
    id: string;
    document: Waiver;
    signer_name: string;
    method: string;
    accepted_at: string;
    recorded_at: string;
  }[];
};
export function MemberRegistrationDetail({ org }: { org: string }) {
  const [params] = useSearchParams();
  const { data, loading, error } = useData<RegistrationDetail | null>(
    `/member/${org}/registrations/${encodeURIComponent(params.get("id") || "")}`,
    null,
  );
  if (loading) return <Loading />;
  if (error || !data)
    return <ErrorBox error={error || "Registration not found"} />;
  return (
    <>
      <p>
        <Link to={`/site/${org}/account/dashboard`}>Back to dashboard</Link>
      </p>
      <h1>{data.program_name}</h1>
      <h2>{data.participant_name}</h2>
      <dl className="member-record-summary">
        <div>
          <dt>Status</dt>
          <dd>{data.status}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{data.role}</dd>
        </div>
        <div>
          <dt>Registered</dt>
          <dd>{shortDate(data.created_at)}</dd>
        </div>
        {data.team_name && (
          <div>
            <dt>Team</dt>
            <dd>{data.team_name}</dd>
          </div>
        )}
      </dl>
      {data.invoice_id && (
        <p>
          <Link to={`/site/${org}/account/invoice?id=${data.invoice_id}`}>
            View invoice
          </Link>
        </p>
      )}
      <h2>Submitted answers</h2>
      {data.fields.length ? (
        <dl className="answer-record">
          {data.fields.map((f) => {
            const value = data.answers[f.id];
            return (
              <div key={f.id}>
                <dt>{f.name}</dt>
                <dd>
                  {value === undefined || value === null || value === "" ? (
                    "Not provided"
                  ) : f.type === "File Upload" ? (
                    <a
                      href={`/api/member/${org}/form-files/${encodeURIComponent(String(value))}`}
                      download
                    >
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
        <p>No additional answers were recorded.</p>
      )}
      <h2>Waiver records</h2>
      {data.waivers.length ? (
        data.waivers.map((w) => (
          <section className="registration-waiver" key={w.id}>
            <h3>
              {w.document.name} · Version {w.document.version}
            </h3>
            <p>
              {w.signer_name} · {shortDate(w.accepted_at)} · {w.method}
            </p>
            <details>
              <summary>View accepted document</summary>
              <HtmlContent html={w.document.content} />
            </details>
          </section>
        ))
      ) : (
        <p>No waiver records are available.</p>
      )}
    </>
  );
}
