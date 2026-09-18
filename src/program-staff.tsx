import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, csv, money, shortDate } from "./api";
import {
  Button,
  Check,
  DataTable,
  ErrorBox,
  ExportButton,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  useData,
} from "./components";
import { ProgramNav } from "./programs";
import { RegistrationRecord } from "./forms";
import type { Person, Program, Registration } from "./types";
type StaffRow = Registration & {
  registration_id: string | null;
  is_primary: boolean;
  invoice_number?: number | null;
};
export function ProgramStaff() {
  const { id } = useParams();
  const programs = useData<Program[]>("/programs", []);
  const staff = useData<StaffRow[]>(`/programs/${id}/staff`, []);
  const [adding, setAdding] = useState(false);
  const defaults = {
    search: "",
    gender: "",
    team: "",
    sort: "registered",
    reverse: false,
  };
  const [draft, setDraft] = useState(defaults),
    [filters, setFilters] = useState(defaults),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [record, setRecord] = useState("");
  const rows = staff.data
    .filter(
      (r) =>
        `${r.first_name} ${r.last_name} ${r.email}`
          .toLowerCase()
          .includes(filters.search.trim().toLowerCase()) &&
        (!filters.gender || (r.gender || "Unknown") === filters.gender) &&
        (!filters.team || r.team_id === filters.team),
    )
    .sort((a, b) => {
      const nameOrder =
        a.last_name.localeCompare(b.last_name) ||
        a.first_name.localeCompare(b.first_name);
      const invoiceStatus = (r: StaffRow) =>
        !r.invoice_id
          ? "No invoice"
          : r.paid_cents >= r.total_cents
            ? "Paid"
            : r.paid_cents > 0
              ? "Partially paid"
              : "Unpaid";
      const amount = (r: StaffRow, balance = false) =>
        r.invoice_id ? r.total_cents - (balance ? r.paid_cents : 0) : 0;
      const order =
        filters.sort === "registered"
          ? b.created_at.localeCompare(a.created_at)
          : filters.sort === "name"
            ? nameOrder
            : filters.sort === "team"
              ? (a.team_name || "").localeCompare(b.team_name || "") ||
                nameOrder
              : filters.sort === "invoice"
                ? invoiceStatus(a).localeCompare(invoiceStatus(b)) || nameOrder
                : filters.sort === "total"
                  ? amount(a) - amount(b) || nameOrder
                  : filters.sort === "balance"
                    ? amount(a, true) - amount(b, true) || nameOrder
                    : a.role.localeCompare(b.role) || nameOrder;
      return order * (filters.reverse ? -1 : 1);
    });
  return (
    <>
      <PageTitle
        title={`${programs.data.find((p) => p.id === id)?.name || "Program"} › Program Staff`}
      />
      <ProgramNav id={id!} active="People" />
      <main className="content-page program-staff-page">
        <div className="split-toolbar">
          <Button onClick={() => setAdding(true)}>
            + Add a Program Staff Member
          </Button>
        </div>
        <ErrorBox error={staff.error || error} />
        <ExportButton
          disabled={staff.loading || !!staff.error}
          onClick={() =>
            csv(
              "program-staff",
              [
                "Staff Name",
                "Email",
                "Registered",
                "Role",
                "Team",
                "Status",
                "Primary",
                "Invoice",
                "Amount Paid",
                "Total Amount Due",
                "Outstanding Balance",
              ],
              rows.map((r) => [
                `${r.first_name} ${r.last_name}`,
                r.email,
                r.created_at,
                r.role,
                r.team_name || "",
                r.status,
                r.is_primary ? "Yes" : "No",
                r.invoice_number || "",
                r.invoice_id ? money(r.paid_cents) : "",
                r.invoice_id ? money(r.total_cents) : "",
                r.invoice_id ? money(r.total_cents - r.paid_cents) : "",
              ]),
            )
          }
        />
        <form
          className="registration-filter-panel"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(draft);
            setVersion((v) => v + 1);
          }}
        >
          <div className="registration-filters">
            <Field label="Name or email">
              <input
                aria-label="Staff name or email"
                value={draft.search}
                onChange={(e) => setDraft({ ...draft, search: e.target.value })}
              />
            </Field>
            <Field label="Gender">
              <Select
                aria-label="Staff gender"
                value={draft.gender}
                onChange={(e) => setDraft({ ...draft, gender: e.target.value })}
                options={[
                  { value: "", label: "Any gender" },
                  ...Array.from(
                    new Set(staff.data.map((r) => r.gender || "Unknown")),
                  ).sort(),
                ]}
              />
            </Field>
            <Field label="Team">
              <Select
                aria-label="Staff team"
                value={draft.team}
                onChange={(e) => setDraft({ ...draft, team: e.target.value })}
                options={[
                  { value: "", label: "All teams" },
                  ...Array.from(
                    new Map(
                      staff.data
                        .filter((r) => r.team_id)
                        .map((r) => [
                          r.team_id!,
                          { value: r.team_id!, label: r.team_name || "Team" },
                        ]),
                    ).values(),
                  ),
                ]}
              />
            </Field>
            <Field label="Sort by">
              <Select
                aria-label="Sort staff by"
                value={draft.sort}
                onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
                options={[
                  { value: "registered", label: "Registration Date" },
                  { value: "name", label: "Name" },
                  { value: "invoice", label: "Invoice Status" },
                  { value: "role", label: "Role" },
                  { value: "team", label: "Team" },
                  { value: "total", label: "Total Amount Due" },
                  { value: "balance", label: "Outstanding Balance" },
                ]}
              />
            </Field>
          </div>
          <div className="inline">
            <Check
              checked={draft.reverse}
              onChange={(e) =>
                setDraft({ ...draft, reverse: e.target.checked })
              }
            >
              Reverse Order
            </Check>
            <Button type="submit">Apply filters</Button>
            <Button
              secondary
              type="button"
              onClick={() => {
                setDraft(defaults);
                setFilters(defaults);
                setVersion((v) => v + 1);
              }}
            >
              Clear filters
            </Button>
          </div>
        </form>
        <p>The primary role identifies the main point of contact for a team.</p>
        {staff.loading ? (
          <Loading />
        ) : (
          !staff.error && (
            <DataTable
              key={version}
              pagination
              rows={rows}
              columns={[
                {
                  key: "name",
                  label: "Staff Name",
                  render: (r) => (
                    <>
                      <Link to={"/members/" + r.person_id}>
                        <strong>
                          {r.first_name} {r.last_name}
                        </strong>
                      </Link>
                      <small className="cell-sub">{r.email}</small>
                    </>
                  ),
                },
                {
                  key: "created_at",
                  label: "Registered",
                  render: (r) => shortDate(r.created_at),
                },
                {
                  key: "role",
                  label: "Role",
                  render: (r) => (
                    <>
                      {r.role}
                      {r.is_primary && (
                        <small className="cell-sub">Primary</small>
                      )}
                    </>
                  ),
                },
                {
                  key: "team",
                  label: "Team",
                  render: (r) =>
                    r.team_id ? (
                      <Link to={"/teams/" + r.team_id}>{r.team_name}</Link>
                    ) : (
                      "—"
                    ),
                },
                { key: "status", label: "Status" },
                {
                  key: "invoice",
                  label: "Invoice",
                  render: (r) =>
                    r.invoice_id ? (
                      <Link to={"/invoices/" + r.invoice_id}>
                        #{r.invoice_number}
                      </Link>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "paid",
                  label: "Amount Paid",
                  render: (r) => (r.invoice_id ? money(r.paid_cents) : "—"),
                },
                {
                  key: "total",
                  label: "Total Amount Due",
                  render: (r) => (r.invoice_id ? money(r.total_cents) : "—"),
                },
                {
                  key: "balance",
                  label: "Outstanding Balance",
                  render: (r) =>
                    r.invoice_id ? money(r.total_cents - r.paid_cents) : "—",
                },
                {
                  key: "waiver",
                  label: "Waiver",
                  render: (r) =>
                    r.registration_id ? (
                      <button
                        className="text-button"
                        onClick={() => setRecord(r.registration_id!)}
                      >
                        {r.waiver_accepted_at ? "Accepted" : "Not accepted"}
                      </button>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (r) =>
                    r.team_id && !r.is_primary && r.status === "Confirmed" ? (
                      <Button
                        secondary
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          try {
                            await api(
                              "/teams/" + r.team_id + "/primary-staff",
                              {
                                method: "POST",
                                body: JSON.stringify({
                                  person_id: r.person_id,
                                }),
                              },
                            );
                            staff.reload();
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Make primary
                      </Button>
                    ) : (
                      "—"
                    ),
                },
              ]}
            />
          )
        )}
      </main>
      {adding && <AddStaff programId={id!} onClose={() => setAdding(false)} />}
      {record && (
        <RegistrationRecord
          registrationId={record}
          onClose={() => setRecord("")}
        />
      )}
    </>
  );
}

function AddStaff({
  programId,
  onClose,
}: {
  programId: string;
  onClose: () => void;
}) {
  const members = useData<Person[]>("/people", []);
  const [person, setPerson] = useState("");
  const context = "?staff_program=" + encodeURIComponent(programId);
  return (
    <Modal title="Add a Program Staff Member" onClose={onClose}>
      <div className="modal-body">
        <p>
          Create a site member first, then choose their program staff role from
          their profile.
        </p>
        <Link className="button" to={"/members/new" + context}>
          Add New Site Member
        </Link>
        <h3 style={{ marginTop: 24 }}>Existing site member</h3>
        <p>Select their profile to complete Program Staff Registration.</p>
        <ErrorBox error={members.error} />
        <Field label="Site member">
          <Select
            aria-label="Site member"
            value={person}
            disabled={members.loading || !!members.error}
            onChange={(e) => setPerson(e.target.value)}
            options={[
              { value: "", label: "Select a member" },
              ...members.data.map((p) => ({
                value: p.id,
                label: `${p.last_name}, ${p.first_name} (${p.email || "No email"})`,
              })),
            ]}
          />
        </Field>
        <div className="form-actions">
          <Button secondary onClick={onClose}>
            Cancel
          </Button>
          {person && (
            <Link className="button" to={"/members/" + person + context}>
              Continue to staff registration
            </Link>
          )}
        </div>
      </div>
    </Modal>
  );
}
