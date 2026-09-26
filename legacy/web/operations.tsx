import {
  InstallmentBreakdown,
  ConvertInvoicePlan,
} from "./invoice-installments";
import { useCallback, useState } from "react";
import { RegistrationTransfer } from "./registration-transfer";
import { RegistrationCancellation } from "./registration-cancellation";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
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
  SearchBox,
  Select,
  Tabs,
  useData,
} from "./components";
import { ProgramNav } from "./programs";
import { RegistrationQuestions, RegistrationRecord } from "./forms";
import type { RegistrationFormValues } from "./forms";
import type {
  Person,
  Program,
  Team,
  Registration,
  Invoice,
  Activity,
  Location,
} from "./types";
export function Registrations() {
  const { id } = useParams();
  const { data: programs } = useData<Program[]>("/programs", []),
    { data: people } = useData<Person[]>("/people", []);
  const { data, error, loading, reload } = useData<Registration[]>(
    "/registrations" + (id ? "?program_id=" + id : ""),
    [],
  );
  const initialFilters = {name: "", email: "", statuses: ["Confirmed", "Pending", "Wait List"], excludedRoles: [] as string[], team: "", gender: "", waiver: "", sort: "registered"};
  const [draft, setDraft] = useState(initialFilters),
    [filters, setFilters] = useState(initialFilters),
    [filterVersion, setFilterVersion] = useState(0),
    [showAllDetails, setShowAllDetails] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]),
    [printing, setPrinting] = useState(false),
    [record, setRecord] = useState(""),
    [canceling, setCanceling] = useState<Registration | null>(null),
    [transferring, setTransferring] = useState<Registration | null>(null),
    [adding, setAdding] = useState(false);
  const close = useCallback(() => setAdding(false), []);
  const p = programs.find((p) => p.id === id);
  const peopleById = new Map(people.map(person => [person.id, person]));
  const roles = Array.from(new Set(["Captain", "Team Player", "Free Agent", ...data.map(r => r.role)])).sort();
  const rows = data.filter(r =>
    `${r.first_name} ${r.last_name}`.toLowerCase().includes(filters.name.trim().toLowerCase()) &&
    r.email.toLowerCase().includes(filters.email.trim().toLowerCase()) &&
    filters.statuses.includes(r.status) && !filters.excludedRoles.includes(r.role) &&
    (!filters.team || (filters.team === "unassigned" ? !r.team_id : r.team_id === filters.team)) &&
    (!filters.gender || (r.gender || "Unknown") === filters.gender) &&
    (!filters.waiver || (filters.waiver === "accepted" ? !!r.waiver_accepted_at : !r.waiver_accepted_at))
  ).sort((a, b) => {
    if (filters.sort === "registered") return b.created_at.localeCompare(a.created_at);
    if (filters.sort === "birthdate") return (a.birthdate || "9999").localeCompare(b.birthdate || "9999");
    if (filters.sort === "role") return a.role.localeCompare(b.role) || a.last_name.localeCompare(b.last_name);
    if (filters.sort === "status") return a.status.localeCompare(b.status) || a.last_name.localeCompare(b.last_name);
    return a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name);
  });
  return (
    <>
      <PageTitle title={p ? p.name + " › Players" : "Registrations"} />
      {id && <ProgramNav id={id} active="People" />}
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="split-toolbar">
          <div className="inline">
            <Button secondary disabled={loading || !!error} onClick={() => setPrinting(true)}>Print This</Button>
            <ExportButton
              onClick={() =>
                csv(
                  "players",
                  ["Name", "Email", "Team", "Role", "Gender", "Status", "Waiver", "Registered"],
                  rows.map((r) => [
                    r.first_name + " " + r.last_name,
                    r.email,
                    r.team_name || "",
                    r.role,
                    r.gender,
                    r.status,
                    r.waiver_accepted_at ? "Accepted" : "Not accepted",
                    r.created_at,
                  ]),
                )
              }
            />
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} />
              Register Member
            </Button>
          </div>
        </div>
        <form className="registration-filter-panel" onSubmit={e => {e.preventDefault(); setFilters(draft); setFilterVersion(v => v + 1);}}>
          <div className="registration-filter-checks">
            <fieldset><legend>Roles</legend><div className="registration-filter-options">{roles.map(role => <Check key={role} checked={!draft.excludedRoles.includes(role)} onChange={e => setDraft(old => ({...old, excludedRoles: e.target.checked ? old.excludedRoles.filter(r => r !== role) : [...old.excludedRoles, role]}))}>{role}</Check>)}</div></fieldset>
            <fieldset><legend>Registration status</legend><div className="registration-filter-options">{["Confirmed", "Pending", "Wait List", "Canceled"].map(status => <Check key={status} checked={draft.statuses.includes(status)} onChange={e => setDraft(old => ({...old, statuses: e.target.checked ? [...old.statuses, status] : old.statuses.filter(s => s !== status)}))}>{status}</Check>)}</div></fieldset>
          </div>
          <div className="registration-filters">
            <Field label="Name"><input aria-label="Filter by name" type="search" value={draft.name} onChange={e => setDraft({...draft, name: e.target.value})} /></Field>
            <Field label="Email"><input aria-label="Filter by email" type="search" value={draft.email} onChange={e => setDraft({...draft, email: e.target.value})} /></Field>
            <Field label="Team">
              <Select aria-label="Filter by team" value={draft.team} onChange={e => setDraft({...draft, team: e.target.value})} options={[
                {value: "", label: "All teams"}, {value: "unassigned", label: "No team assigned"},
                ...Array.from(new Map(data.filter(r => r.team_id).map(r => [r.team_id!, {value: r.team_id!, label: r.team_name || "Unnamed team"}])).values()).sort((a,b) => a.label.localeCompare(b.label)),
              ]} />
            </Field>
            <Field label="Gender">
              <Select aria-label="Filter by gender" value={draft.gender} onChange={e => setDraft({...draft, gender: e.target.value})} options={[{value: "", label: "Any gender"}, ...Array.from(new Set(data.map(r => r.gender || "Unknown"))).sort()]} />
            </Field>
            <Field label="Waiver">
              <Select aria-label="Filter by waiver" value={draft.waiver} onChange={e => setDraft({...draft, waiver: e.target.value})} options={[{value: "", label: "Any waiver status"}, {value: "accepted", label: "Waiver accepted"}, {value: "missing", label: "Waiver not accepted"}]} />
            </Field>
            <Field label="Sort by"><Select aria-label="Sort players by" value={draft.sort} onChange={e => setDraft({...draft, sort: e.target.value})} options={[{value: "registered", label: "Registration Date"}, {value: "birthdate", label: "Birth Date"}, {value: "name", label: "Last Name"}, {value: "role", label: "Role"}, {value: "status", label: "Status"}]} /></Field>
          </div>
          <div className="inline"><Button type="submit">Apply filters</Button><Button type="button" secondary onClick={() => {setDraft(initialFilters); setFilters(initialFilters); setFilterVersion(v => v + 1);}}>Clear filters</Button></div>
        </form>
        <p className="subtle">
          Showing {rows.length} {rows.length === 1 ? "player" : "players"} matching your filters.
        </p>
        <Check checked={showAllDetails} onChange={e => {setShowAllDetails(e.target.checked); setExpanded([]);}}>Show all player details</Check>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            key={filterVersion}
            rows={rows}
            pagination
            details={r => (showAllDetails ? !expanded.includes(r.id) : expanded.includes(r.id)) ? <section className="player-registration-details" aria-label={`Registration details for ${r.first_name} ${r.last_name}`}>
              <Link to={"/members/" + r.person_id}>View full profile</Link>
              <dl className="answer-record">
                <div><dt>Original role</dt><dd>{r.original_role || "Not recorded"}</dd></div>
                <div><dt>Mobile number</dt><dd>{peopleById.get(r.person_id)?.phone || "Not recorded"}</dd></div>
                <div><dt>SMS opt-in</dt><dd>{peopleById.get(r.person_id)?.sms_opt_in === true ? "Yes" : peopleById.get(r.person_id)?.sms_opt_in === false ? "No" : "Not recorded"}</dd></div>
              </dl>
              <RegistrationRecord key={r.id} registrationId={r.id} inline />
            </section> : null}
            columns={[
              {
                key: "name",
                label: "Player Name",
                render: (r) => (
                  <>
                    <Link to={"/members/" + r.person_id}><strong>{r.first_name} {r.last_name}</strong></Link>
                    <small className="cell-sub">{r.email}</small>
                    <button type="button" className="team-details-toggle" aria-label={`Details for ${r.first_name} ${r.last_name}`} aria-expanded={showAllDetails ? !expanded.includes(r.id) : expanded.includes(r.id)} onClick={() => setExpanded(old => old.includes(r.id) ? old.filter(value => value !== r.id) : [...old, r.id])}>{(showAllDetails ? !expanded.includes(r.id) : expanded.includes(r.id)) ? "Hide details" : "Show details"}</button>
                  </>
                ),
              },
              {
                key: "created_at",
                label: "Registered",
                render: (r) => shortDate(r.created_at),
              },
              { key: "gender", label: "Gender" },
              {
                key: "birthdate",
                label: "Birthdate",
                render: (r) => shortDate(r.birthdate),
              },
              { key: "role", label: "Role", render: r => <>{r.role}{r.team_id && <small className="cell-sub"><Link to={"/teams/" + r.team_id}>{r.team_name || "View team"}</Link></small>}</> },
              {
                key: "status",
                label: "Status",
                render: (r) => (
                  <span
                    className={
                      "badge " + r.status.toLowerCase().replace(" ", "-")
                    }
                  >
                    {r.status}
                  </span>
                ),
              },
              {
                key: "payment",
                label: "Payment",
                render: (r) =>
                  r.invoice_id ? (
                    <Link to={"/invoices/" + r.invoice_id}>
                      {money(r.paid_cents)} / {money(r.total_cents)}
                    </Link>
                  ) : (
                    "—"
                  ),
              },
              {
                key: "waiver",
                label: "Waiver",
                render: (r) => (
                  <button
                    className="text-button"
                    aria-label={`View form and waivers for ${r.first_name} ${r.last_name}`}
                    onClick={() => setRecord(r.id)}
                  >
                    {r.waiver_accepted_at ? "Accepted" : "Not accepted"}
                    <small className="cell-sub">View form</small>
                  </button>
                ),
              },
              { key: "actions", label: "Actions", render: r => r.status !== "Canceled" ? <div className="cell-actions"><button type="button" className="text-button" aria-label={`Cancel registration for ${r.first_name} ${r.last_name}`} onClick={() => setCanceling(r)}>Cancel registration</button>{["Free Agent", "Team Player"].includes(r.role) && <button type="button" className="text-button" aria-label={`Transfer registration for ${r.first_name} ${r.last_name}`} onClick={() => setTransferring(r)}>Transfer</button>}</div> : "—" },
            ]}
          />
        )}
      </main>
      {printing && <Modal title="Print players" wide onClose={() => setPrinting(false)}>
        <div className="modal-body">
          <section className="print-roster print-players">
            <header><h1>{p?.name || "Registrations"}</h1><p>{rows.length} {rows.length === 1 ? "player" : "players"} matching the applied filters</p></header>
            <div className="table-scroll"><table>
              <thead><tr>{["Player", "Team / Role", "Registered", "Birthdate", "Status", "Payment", "Waiver"].map(label => <th key={label}>{label}</th>)}</tr></thead>
              <tbody>{rows.map(r => <tr key={r.id}>
                <td><strong>{r.first_name} {r.last_name}</strong><small className="cell-sub">{r.email}</small></td>
                <td>{r.team_name || "No team assigned"}<small className="cell-sub">{r.role}</small></td>
                <td>{shortDate(r.created_at)}</td><td>{shortDate(r.birthdate)}</td><td>{r.status}</td>
                <td>{r.invoice_id ? `${money(r.paid_cents)} / ${money(r.total_cents)}` : "Not invoiced"}</td>
                <td>{r.waiver_accepted_at ? "Accepted" : "Not accepted"}</td>
              </tr>)}</tbody>
            </table></div>
          </section>
          <div className="form-actions"><Button type="button" onClick={() => window.print()}>Print</Button><Button type="button" secondary onClick={() => setPrinting(false)}>Close preview</Button></div>
        </div>
      </Modal>}
      {record && (
        <RegistrationRecord
          registrationId={record}
          onClose={() => setRecord("")}
        />
      )}
      {transferring && <RegistrationTransfer key={transferring.id} registration={transferring} onClose={() => setTransferring(null)} onDone={() => { setTransferring(null); reload(); }} />}
      {canceling && <RegistrationCancellation key={canceling.id} registrationId={canceling.id} name={`${canceling.first_name} ${canceling.last_name}`} onClose={() => setCanceling(null)} onDone={() => { setCanceling(null); reload(); }} />}
      {adding && (
        <Modal title="Register Member" onClose={close}>
          <RegistrationForm
            programs={programs}
            people={people}
            programId={id ?? ""}
            done={() => {
              close();
              reload();
            }}
            cancel={close}
          />
        </Modal>
      )}
    </>
  );
}
function RegistrationForm({
  programs,
  people,
  programId,
  done,
  cancel,
}: {
  programs: Program[];
  people: Person[];
  programId: string;
  done: () => void;
  cancel: () => void;
}) {
  const [form, setForm] = useState({
      program_id: programId,
      person_id: "",
      team_id: "",
      role: "Free Agent",
      waiver_accepted: false,
      discount_code: "",
      answers: {} as RegistrationFormValues["answers"],
      waiver_acceptances: [] as RegistrationFormValues["waiver_acceptances"],
      form_version: 0,
      has_waivers: false,
      form_context: "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const teamData = useData<Team[]>("/teams" + (form.program_id ? "?program_id=" + encodeURIComponent(form.program_id) : ""), []);
  const p = programs.find((p) => p.id === form.program_id);
  const formContext = [form.program_id, form.person_id, form.role].join(":");
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/registrations", {
            method: "POST",
            body: JSON.stringify({ ...form, team_id: form.team_id || null }),
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
      <Field label="Program" required>
        <Select
          required
          aria-label="Program"
          value={form.program_id}
          onChange={(e) =>
            setForm({ ...form, program_id: e.target.value, team_id: "", role: "Free Agent" })
          }
          options={[
            { value: "", label: "Select a program" },
            ...programs
              .filter((p) => !p.grouped)
              .map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </Field>
      <Field label="Member" required>
        <Select
          required
          aria-label="Member"
          value={form.person_id}
          onChange={(e) => setForm({ ...form, person_id: e.target.value })}
          options={[
            { value: "", label: "Select a member" },
            ...people.map((p) => ({
              value: p.id,
              label: p.first_name + " " + p.last_name,
            })),
          ]}
        />
      </Field>
      <ErrorBox error={teamData.error} />
      <Field label="Team">
        <Select
          disabled={!form.program_id || teamData.loading || !!teamData.error}
          aria-label="Team"
          value={form.team_id}
          onChange={(e) =>
            setForm({
              ...form,
              team_id: e.target.value,
              role: e.target.value ? "Team Player" : "Free Agent",
            })
          }
          options={[
            { value: "", label: "Free Agent — no team assigned" },
            ...(teamData.loading || teamData.error ? [] : teamData.data)
              .filter((t) => t.program_id === form.program_id)
              .map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      </Field>
      <Field label="Discount Code">
        <input
          maxLength={64}
          value={form.discount_code}
          onChange={(e) => setForm({ ...form, discount_code: e.target.value })}
        />
      </Field>
      {form.program_id && form.person_id && (
        <RegistrationQuestions
          key={formContext}
          programId={form.program_id}
          personId={form.person_id}
          role={form.role}
          onChange={(value) =>
            setForm((old) => ({ ...old, ...value, form_context: formContext }))
          }
        />
      )}
      {!form.has_waivers && (
        <Check
          checked={form.waiver_accepted}
          onChange={(e) =>
            setForm({ ...form, waiver_accepted: e.target.checked })
          }
        >
          Waiver acceptance has been received
        </Check>
      )}
      {p && (
        <div className="info-box">
          Registration fee: <strong>{money(p.fee_cents)}</strong>.{" "}
          {p.capacity
            ? `${p.players} registered · ${p.capacity} capacity.`
            : "No capacity limit."}{" "}
          {p.waitlist ? "Waiting list enabled." : ""}
        </div>
      )}
      <div className="form-actions">
        <Button secondary type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button
          disabled={
            busy || !form.form_version || form.form_context !== formContext
          }
        >
          Register Member
        </Button>
      </div>
    </form>
  );
}
export function Invoices() {
  const [params] = useSearchParams(),
    { data, error, loading } = useData<Invoice[]>("/invoices", []);
  const { data: programs } = useData<Program[]>("/programs", []),
    [search, setSearch] = useState(""),
    [program, setProgram] = useState(params.get("program_id") ?? ""),
    [status, setStatus] = useState(params.get("status") ?? "");
  const rows = data.filter(
    (i) =>
      (!program || i.program_id === program) &&
      (!status ||
        (status === "Void"
          ? !!i.voided
          : !i.voided &&
            (status === "Paid"
              ? i.paid_cents === i.total_cents
              : i.paid_cents < i.total_cents))) &&
      `${i.number} ${i.first_name} ${i.last_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle title="Invoices" />
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="split-toolbar">
          <div className="inline">
            <SearchBox
              placeholder="Invoice number or member name"
              value={search}
              onChange={setSearch}
            />
            <Select
              aria-label="Invoice program"
              options={[
                { value: "", label: "All Programs" },
                ...programs.map((p) => ({ value: p.id, label: p.name })),
              ]}
              value={program}
              onChange={(e) => setProgram(e.target.value)}
            />
            <Select
              aria-label="Invoice status"
              options={[
                { value: "", label: "All Statuses" },
                "Paid",
                "Outstanding",
                "Void",
              ]}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            />
          </div>
          <ExportButton
            onClick={() =>
              csv(
                "invoices",
                ["Number", "Member", "Status", "Invoiced", "Paid", "Balance", "Due Date"],
                rows.map((i) => [
                  i.number,
                  i.first_name + " " + i.last_name,
                  i.voided ? "Void" : i.paid_cents >= i.total_cents ? "Paid" : "Outstanding",
                  money(i.total_cents),
                  money(i.paid_cents),
                  money(i.voided ? 0 : i.total_cents - i.paid_cents),
                  i.due_date,
                ]),
              )
            }
          />
        </div>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={rows}
            pagination
            columns={[
              {
                key: "person",
                label: "Invoiced",
                sort: (i) => i.last_name,
                render: (i) => (
                  <strong>
                    {i.first_name} {i.last_name}
                  </strong>
                ),
              },
              {
                key: "description",
                label: "Invoice Details",
                render: (i) => (
                  <>
                    <Link to={"/invoices/" + i.id}>Invoice #{i.number}</Link>
                    <small>{i.description}</small>
                  </>
                ),
              },
              {
                key: "created_at",
                label: "Date / Last Action",
                render: (i) => shortDate(i.created_at),
              },
              {
                key: "status",
                label: "Status",
                render: (i) => (
                  <span
                    className={
                      "badge " +
                      (i.total_cents === i.paid_cents ? "confirmed" : "pending")
                    }
                  >
                    {i.voided
                      ? "Void"
                      : i.total_cents === i.paid_cents
                        ? "Paid"
                        : "Unpaid"}
                  </span>
                ),
              },
              {
                key: "due_date",
                label: "Deadline",
                render: (i) => shortDate(i.due_date),
              },
              {
                key: "balance",
                label: "Total / Balance",
                render: (i) => (
                  <>
                    {money(i.total_cents)}
                    <small>
                      {money(i.voided ? 0 : i.total_cents - i.paid_cents)} due
                    </small>
                  </>
                ),
              },
              {
                key: "actions",
                label: "Actions",
                render: (i) => <Link to={"/invoices/" + i.id}>View</Link>,
              },
            ]}
          />
        )}
      </main>
    </>
  );
}
export function InvoiceDetail() {
  const { id } = useParams(),
    {
      data: i,
      error,
      loading,
      reload,
    } = useData<Invoice | null>("/invoices/" + id, null),
    [pay, setPay] = useState(false),
    [convert, setConvert] = useState(false);
  const close = useCallback(() => setPay(false), []);
  if (loading) return <Loading />;
  if (!i) return <ErrorBox error={error} />;
  return (
    <>
      <PageTitle
        title={"Invoice #" + i.number}
        crumbs={[{ label: "Invoices", to: "/invoices" }]}
      />
      <main className="invoice-sheet">
        <div className="split-toolbar">
          <div>
            <h2>
              {i.person.first_name} {i.person.last_name}
            </h2>
            <p>{i.person.email}</p>
          </div>
          <span
            className={
              "badge " +
              (i.paid_cents === i.total_cents ? "confirmed" : "pending")
            }
          >
            {i.voided
              ? "Void"
              : i.paid_cents === i.total_cents
                ? "Paid"
                : "Payment Due"}
          </span>
        </div>
        <div className="metric-grid three">
          <div className="metric">
            <div>
              <span>Total Invoiced</span>
              <strong>{money(i.total_cents)}</strong>
            </div>
          </div>
          <div className="metric">
            <div>
              <span>Paid</span>
              <strong>{money(i.paid_cents)}</strong>
            </div>
          </div>
          <div className="metric">
            <div>
              <span>Balance Due</span>
              <strong>
                {money(i.voided ? 0 : i.total_cents - i.paid_cents)}
              </strong>
            </div>
          </div>
        </div>
        {i.payment_plan ? (
          <InstallmentBreakdown plan={i.payment_plan} />
        ) : (
          !i.voided &&
          i.paid_cents === 0 &&
          i.program_id &&
          !i.order_id && (
            <p>
              <Button secondary onClick={() => setConvert(true)}>
                Convert to Payment Plan
              </Button>
            </p>
          )
        )}
        {convert && (
          <ConvertInvoicePlan
            invoiceId={i.id}
            programId={i.program_id}
            total={i.total_cents}
            close={() => setConvert(false)}
            saved={() => {
              setConvert(false);
              reload();
            }}
          />
        )}
        <h3>Invoice Details</h3>
        <p>{i.description}</p>
        {i.order_id && (
          <>
            <p>
              Subtotal {money(i.subtotal_cents)} · Shipping{" "}
              {money(i.shipping_cents)} · Tax {money(i.tax_cents)}
            </p>
            <p>
              <Link to={"/orders/" + i.order_id}>View Product Order</Link>
            </p>
          </>
        )}
        {!!i.discount_cents && (
          <p>
            Registration: {money(i.base_cents ?? i.total_cents)} · Discount (
            {i.discount_code}): −{money(i.discount_cents)}
          </p>
        )}
        <p>
          Created {shortDate(i.created_at)} · Due {shortDate(i.due_date)}
        </p>
        <hr />
        <div className="split-toolbar">
          <h3>Payment History</h3>
          {!i.voided && i.total_cents > i.paid_cents && (
            <Button onClick={() => setPay(true)}>Record Offline Payment</Button>
          )}
        </div>
        <DataTable
          rows={i.transactions}
          columns={[
            {
              key: "created_at",
              label: "Date",
              render: (t) => shortDate(t.created_at),
            },
            { key: "method", label: "Method" },
            {
              key: "amount",
              label: "Amount",
              render: (t) => money(t.amount_cents),
            },
          ]}
        />
        {!!i.credit_applications?.length && (
          <>
            <h3>Credits Applied</h3>
            <DataTable
              rows={i.credit_applications}
              columns={[
                {
                  key: "created_at",
                  label: "Date",
                  render: (c) => shortDate(c.created_at),
                },
                { key: "description", label: "Description" },
                {
                  key: "amount_cents",
                  label: "Amount",
                  render: (c) => money(c.amount_cents),
                },
              ]}
            />
          </>
        )}
      </main>
      {pay && (
        <Modal title="Record Offline Payment" onClose={close}>
          <PaymentForm
            invoice={i}
            cancel={close}
            done={() => {
              close();
              reload();
            }}
          />
        </Modal>
      )}
    </>
  );
}
function PaymentForm({
  invoice,
  cancel,
  done,
}: {
  invoice: Invoice;
  cancel: () => void;
  done: () => void;
}) {
  const [position, setPosition] = useState("");
  const selectedBalance = position
    ? (invoice.payment_plan?.installments.find(
        (row) => row.position === Number(position),
      )?.balance_cents ?? 0)
    : invoice.total_cents - invoice.paid_cents;
  const [amount, setAmount] = useState(
      String((invoice.total_cents - invoice.paid_cents) / 100),
    ),
    [method, setMethod] = useState("Check"),
    [reference, setReference] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [key] = useState(() => crypto.randomUUID());
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/invoices/" + invoice.id + "/payments", {
            method: "POST",
            body: JSON.stringify({
              amount_cents: Math.round(Number(amount) * 100),
              method,
              reference,
              idempotency_key: key,
              ...(position ? { installment_position: Number(position) } : {}),
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
        Record money already received outside Athlentry. This records a receipt
        and does not charge a bank account or card.
      </p>
      {invoice.payment_plan && (
        <Field label="Apply payment to">
          <Select
            value={position}
            onChange={(e) => {
              setPosition(e.target.value);
              const balance = e.target.value
                ? invoice.payment_plan!.installments.find(
                    (row) => row.position === Number(e.target.value),
                  )!.balance_cents
                : invoice.total_cents - invoice.paid_cents;
              setAmount(String(balance / 100));
            }}
            options={[
              { value: "", label: "Earliest unpaid installments" },
              ...invoice.payment_plan.installments
                .filter((row) => row.balance_cents > 0)
                .map((row) => ({
                  value: String(row.position),
                  label:
                    "Installment " +
                    row.position +
                    " · " +
                    shortDate(row.due_date) +
                    " · " +
                    money(row.balance_cents),
                })),
            ]}
          />
        </Field>
      )}
      <Field label="Amount" required>
        <input
          type="number"
          min="0.01"
          step="0.01"
          max={selectedBalance / 100}
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label="Payment method">
        <Select
          options={["Check", "Cash", "Bank transfer", "Other"]}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        />
      </Field>
      <Field label="Reference / Check number">
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </Field>
      <div className="form-actions">
        <Button secondary type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button disabled={busy}>Record Payment</Button>
      </div>
    </form>
  );
}
