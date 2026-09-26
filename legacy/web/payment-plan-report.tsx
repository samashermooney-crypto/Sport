import { useState } from "react";
import { Link } from "react-router-dom";
import { csv, money, shortDate } from "./api";
import {
  Button,
  DataTable,
  DateInput,
  ErrorBox,
  ExportButton,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  useData,
} from "./components";
type Detail = {
  id: string;
  invoice_id: string;
  invoice_number: number;
  person_id: string;
  registrant_name: string;
  amount_due: number;
  amount_paid: number;
  outstanding: number;
};
type Row = {
  id: string;
  due_date: string;
  program_id: string;
  program_name: string;
  program_code: string;
  plan_name: string;
  autopay: boolean;
  total_due: number;
  total_paid: number;
  total_outstanding: number;
  installments_due: number;
  installments_paid: number;
  installments_outstanding: number;
  details: Detail[];
};
type Report = { period: string; from: string; to: string; rows: Row[] };
const periods = [
  "This Month",
  "Last Month",
  "Next Month",
  "This Week",
  "Last Week",
  "Next Week",
  "Last 7 Days",
  "Next 7 Days",
  "Last 30 Days",
  "Next 30 Days",
  "Today",
  "Custom Range",
];
export function PaymentPlanReport() {
  const [query, setQuery] = useState(""),
    [period, setPeriod] = useState("This Month"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [detail, setDetail] = useState<Row | null>(null);
  const report = useData<Report>("/reports/payment-plans" + query, {
    period: "This Month",
    from: "",
    to: "",
    rows: [],
  });
  function run() {
    const q = new URLSearchParams({ period });
    if (period === "Custom Range") {
      q.set("from", from || report.data.from);
      q.set("to", to || report.data.to);
    }
    setQuery("?" + q);
    report.reload();
  }
  return (
    <>
      <PageTitle title="Payment Plans Summary" />
      <main className="content-page payment-plan-report">
      <div className="page-tools">
        <div className="inline">
          <Field label="Due">
            <Select
              options={periods}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </Field>
          {period === "Custom Range" && (
            <>
              <Field label="Beginning">
                <DateInput
                  value={from || report.data.from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field
                label="Until"
                hint="End date is excluded. Maximum 93 days."
              >
                <DateInput
                  value={to || report.data.to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </>
          )}
          <Button onClick={run}>Run Report</Button>
        </div>
        <ExportButton
          disabled={report.loading || !!report.error}
          onClick={() =>
            csv(
              "payment-plans-summary",
              [
                "Due date",
                "Program Name",
                "Program Code",
                "Total Due",
                "Total Paid",
                "Total Outstanding",
                "Installments Due",
                "Installments Paid",
                "Installments Outstanding",
                "Payment Plan Name",
                "Auto Pay",
              ],
              report.data.rows.map((r) => [
                r.due_date,
                r.program_name,
                r.program_code,
                money(r.total_due),
                money(r.total_paid),
                money(r.total_outstanding),
                r.installments_due,
                r.installments_paid,
                r.installments_outstanding,
                r.plan_name,
                r.autopay ? "Yes" : "No",
              ]),
            )
          }
        />
      </div>
      <ErrorBox error={report.error} />
      {report.loading ? (
        <Loading />
      ) : (
        !report.error && (
          <>
            <p>
              Date Period: Beginning {shortDate(report.data.from)} until{" "}
              {shortDate(report.data.to)}
            </p>
            {report.data.rows.length ? (
              <DataTable
                rows={report.data.rows}
                columns={[
                  {
                    key: "due_date",
                    label: "Due date",
                    render: (r) => shortDate(r.due_date),
                  },
                  {
                    key: "program_name",
                    label: "Program Name",
                    render: (r) => (
                      <Link to={"/programs/" + r.program_id}>
                        {r.program_name}
                      </Link>
                    ),
                  },
                  { key: "program_code", label: "Program Code" },
                  {
                    key: "total_due",
                    label: "Total Due",
                    render: (r) => money(r.total_due),
                  },
                  {
                    key: "total_paid",
                    label: "Total Paid",
                    render: (r) => money(r.total_paid),
                  },
                  {
                    key: "total_outstanding",
                    label: "Total Outstanding",
                    render: (r) => money(r.total_outstanding),
                  },
                  { key: "installments_due", label: "Installments Due" },
                  { key: "installments_paid", label: "Installments Paid" },
                  {
                    key: "installments_outstanding",
                    label: "Installments Outstanding",
                  },
                  { key: "plan_name", label: "Payment Plan Name" },
                  {
                    key: "autopay",
                    label: "Auto Pay",
                    render: (r) => (r.autopay ? "Yes" : "No"),
                  },
                  {
                    key: "actions",
                    label: "Actions",
                    render: (r) => (
                      <Button secondary onClick={() => setDetail(r)}>
                        Show Details
                      </Button>
                    ),
                  },
                ]}
              />
            ) : (
              <p>No Payment Plans due in time period</p>
            )}
          </>
        )
      )}
      {detail && (
        <Modal
          wide
          title={"Payment Plan Details · " + shortDate(detail.due_date)}
          onClose={() => setDetail(null)}
        >
          <div className="modal-body payment-plan-details">
          <h3>
            {detail.program_name} · {detail.plan_name}
          </h3>
          <ExportButton
            onClick={() =>
              csv(
                "payment-plan-details",
                [
                  "Registrant Name",
                  "Amount Due",
                  "Amount Paid",
                  "Outstanding",
                  "Invoice ID",
                ],
                detail.details.map((r) => [
                  r.registrant_name,
                  money(r.amount_due),
                  money(r.amount_paid),
                  money(r.outstanding),
                  r.invoice_number,
                ]),
              )
            }
          />
          <DataTable
            rows={detail.details}
            columns={[
              {
                key: "registrant_name",
                label: "Registrant Name",
                render: (r) => (
                  <Link to={"/members/" + r.person_id}>
                    {r.registrant_name}
                  </Link>
                ),
              },
              {
                key: "amount_due",
                label: "Amount Due",
                render: (r) => money(r.amount_due),
              },
              {
                key: "amount_paid",
                label: "Amount Paid",
                render: (r) => money(r.amount_paid),
              },
              {
                key: "outstanding",
                label: "Outstanding",
                render: (r) => money(r.outstanding),
              },
              {
                key: "invoice_number",
                label: "Invoice ID",
                render: (r) => (
                  <Link to={"/invoices/" + r.invoice_id}>
                    {r.invoice_number}
                  </Link>
                ),
              },
            ]}
          />
          </div>
        </Modal>
      )}
      </main>
    </>
  );
}
