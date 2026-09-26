import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Settings2,
  CalendarDays,
  Wallet,
  ClipboardList,
  Users,
} from "lucide-react";
import { api, csv, money, shortDate } from "./api";
import {
  Button,
  Check,
  DataTable,
  ErrorBox,
  ExportButton,
  Field,
  FieldGroup,
  Loading,
  Modal,
  PageTitle,
  SearchBox,
  Select,
  Tabs,
  useData,
} from "./components";
import type { Column } from "./components";
import type { Program, Location } from "./types";
import { useTerminology, termChoices, type Terminology } from "./terminology";
export const programTypes = [
  "League",
  "Event",
  "Tournament",
  "Camp",
  "Club team",
  "Class",
];
function CreateProgram() {
  const [open, setOpen] = useState(false);
  return (
    <div className="dropdown">
      <Button onClick={() => setOpen(!open)}>
        <Plus size={14} />
        Create program
      </Button>
      {open && (
        <div className="dropdown-menu">
          <small>Create a new…</small>
          {programTypes.map((type) => (
            <Link
              key={type}
              to={"/programs/new?type=" + encodeURIComponent(type)}
              onClick={() => setOpen(false)}
            >
              {type}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
function useProgramFilter(programs: Program[]) {
  const [tab, setTab] = useState("Live and Upcoming"),
    [search, setSearch] = useState("");
  const filtered = programs.filter(
    (p) =>
      (tab === "Completed"
        ? p.status === "Completed"
        : tab === "Unpublished"
          ? p.status === "Unpublished"
          : ["Live", "Upcoming"].includes(p.status)) &&
      p.name.toLowerCase().includes(search.toLowerCase()),
  );
  return { tab, setTab, search, setSearch, filtered };
}
const summaryColumns = {
  code: "Program Code",
  start_date: "Start Date",
  registration_start: "Registration Start",
  registration_end: "Registration End",
  invoiced: "Invoiced",
  paid: "Paid",
  outstanding: "Outstanding",
  paid_invoices: "Paid Invoices",
  partial_invoices: "Partial Invoices",
  unpaid_invoices: "Unpaid Invoices",
  overdue: "Amount Overdue",
  players: "Players",
  capacity: "Max Players",
  free_agents: "Free Agents",
  staff: "Staff",
  teams: "Teams",
  status: "State",
  type: "Type",
  sport: "Sport",
};
type SummaryKey = keyof typeof summaryColumns;
export function ProgramSummary({
  standalone = false,
}: {
  standalone?: boolean;
}) {
  const { data, error, loading } = useData<Program[]>("/programs", []);
  const { tab, setTab, search, setSearch, filtered } = useProgramFilter(data);
  const view = useData<{ version: number; columns: SummaryKey[] }>(
    "/reports/program-summary/view",
    {
      version: 1,
      columns: [
        "paid",
        "outstanding",
        "players",
        "free_agents",
        "staff",
        "teams",
      ],
    },
  );
  const [draft, setDraft] = useState<SummaryKey[]>([]);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]),
    [custom, setCustom] = useState(false);
  const roots = filtered.filter((p) => !p.parent_id),
    rows = roots.flatMap((p) => [
      p,
      ...(expanded.includes(p.id)
        ? filtered.filter((c) => c.parent_id === p.id)
        : []),
    ]);
  function total(p: Program, key: keyof Program): number {
    return (
      Number(p[key] ?? 0) +
      data
        .filter((c) => c.parent_id === p.id)
        .reduce((sum, c) => sum + Number(c[key] ?? 0), 0)
    );
  }
  const columns: Column<Program>[] = [
    {
      key: "expand",
      label: "",
      render: (p: Program) =>
        p.grouped ? (
          <button
            className="icon-button"
            aria-label={"Expand " + p.name}
            onClick={() =>
              setExpanded(
                expanded.includes(p.id)
                  ? expanded.filter((id) => id !== p.id)
                  : [...expanded, p.id],
              )
            }
          >
            {expanded.includes(p.id) ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
          </button>
        ) : null,
    },
    {
      key: "name",
      label: "Program",
      sort: (p: Program) => p.name,
      render: (p: Program) => (
        <Link
          className={"program-name " + (p.parent_id ? "indent" : "")}
          to={"/programs/" + p.id}
        >
          {p.name}
        </Link>
      ),
    },
    ...Object.entries(summaryColumns)
      .filter(([key]) => view.data.columns.includes(key as SummaryKey))
      .map(([key, label]) => ({
        key,
        label,
        sort: (p: Program) => summaryValue(p, key as SummaryKey),
        render: (p: Program) => {
          const value = summaryDisplay(p, key as SummaryKey);
          if (["invoiced", "paid", "outstanding", "overdue"].includes(key))
            return <Link to={"/invoices?program_id=" + p.id}>{value}</Link>;
          if (["players", "free_agents", "staff", "teams"].includes(key))
            return (
              <Link
                to={
                  "/programs/" + p.id + (key === "teams" ? "/teams" : "/people")
                }
              >
                {value}
              </Link>
            );
          return value;
        },
      })),
  ];
  function summaryValue(p: Program, key: SummaryKey): string | number {
    if (
      [
        "invoiced",
        "paid",
        "outstanding",
        "paid_invoices",
        "partial_invoices",
        "unpaid_invoices",
        "overdue",
        "players",
        "free_agents",
        "staff",
        "teams",
      ].includes(key)
    )
      return total(p, key);
    return p[key] ?? "";
  }
  function summaryDisplay(p: Program, key: SummaryKey) {
    const value = summaryValue(p, key);
    if (["invoiced", "paid", "outstanding", "overdue"].includes(key))
      return money(Number(value));
    if (["start_date", "registration_start", "registration_end"].includes(key))
      return shortDate(String(value));
    if (key === "capacity" && p.capacity === null) return "Unlimited";
    return value;
  }
  async function saveColumns() {
    setSaving(true);
    setSaveError("");
    try {
      await api("/reports/program-summary/view", {
        method: "PUT",
        body: JSON.stringify({ version: view.data.version, columns: draft }),
      });
      view.reload();
      setCustom(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      {standalone && <PageTitle title="Reports › Programs Summary" />}
      <section className={standalone ? "program-summary content-page" : "program-summary"}>
        <div className="section-heading">
          <h2>Program Summary</h2>
          {!standalone && <Link to="/programs">View all programs</Link>}
        </div>
        <ErrorBox error={error || view.error} />
        {standalone && !loading && !error && (
          <>
            <div className="program-summary-totals">
              {(
                [
                  ["Invoiced", "invoiced", "/invoices"],
                  ["Paid", "paid", "/invoices?status=Paid"],
                  [
                    "Outstanding",
                    "outstanding",
                    "/invoices?status=Outstanding",
                  ],
                  ["Teams", "teams", "/teams"],
                  ["Registrations", "registrations", "/registrations"],
                ] as const
              ).map(([label, key, to]) => {
                const value = data.reduce(
                  (sum, p) => sum + Number(p[key] ?? 0),
                  0,
                );
                return (
                  <Link className="metric" to={to} key={key}>
                    <div>
                      <span>{label.toUpperCase()}</span>
                      <strong>
                        {[
                          "invoiced",
                          "paid",
                          "outstanding",
                          "overdue",
                        ].includes(key)
                          ? money(value)
                          : value.toLocaleString()}
                      </strong>
                    </div>
                  </Link>
                );
              })}
            </div>
            <h2>Program Details</h2>
          </>
        )}
        <div className="inline">
          <SearchBox value={search} onChange={setSearch} />
          <button className="text-button" onClick={() => setSearch("")}>
            Clear filter
          </button>
        </div>
        <div className="split-toolbar">
          <Tabs
            items={["Live and Upcoming", "Unpublished", "Completed"]}
            value={tab}
            onChange={setTab}
          />
          <div className="inline">
            <ExportButton
              onClick={() =>
                csv(
                  "program-summary",
                  [
                    "Program",
                    ...Object.entries(summaryColumns)
                      .filter(([key]) =>
                        view.data.columns.includes(key as SummaryKey),
                      )
                      .map(([, label]) => label),
                  ],
                  rows.map((p) => [
                    p.name,
                    ...Object.keys(summaryColumns)
                      .filter((key) =>
                        view.data.columns.includes(key as SummaryKey),
                      )
                      .map((key) => summaryDisplay(p, key as SummaryKey)),
                  ]),
                )
              }
            />
            <Button
              secondary
              disabled={view.loading || !!view.error}
              onClick={() => {
                setDraft([...view.data.columns]);
                setSaveError("");
                setCustom(true);
              }}
            >
              <Settings2 size={14} /> Customize view
            </Button>
            {custom && (
              <Modal
                title="Program Summary Columns"
                onClose={() => {
                  if (!saving) setCustom(false);
                }}
              >
                <div className="modal-body">
                <p>
                  Select which columns you would like to display in the report.
                  The selection made here will be reflected on the main
                  dashboard as well.
                </p>
                <ErrorBox error={saveError} />
                <div className="summary-column-options">
                  <Check checked disabled>
                    Program
                  </Check>
                  {Object.entries(summaryColumns).map(([key, label]) => (
                    <Check
                      key={key}
                      checked={draft.includes(key as SummaryKey)}
                      disabled={saving}
                      onChange={() =>
                        setDraft(
                          draft.includes(key as SummaryKey)
                            ? draft.filter((k) => k !== key)
                            : [...draft, key as SummaryKey],
                        )
                      }
                    >
                      {label}
                    </Check>
                  ))}
                </div>
                <div className="form-actions">
                  <Button disabled={saving} onClick={saveColumns}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    secondary
                    disabled={saving}
                    onClick={() => setCustom(false)}
                  >
                    Close
                  </Button>
                </div>
                </div>
              </Modal>
            )}
            <CreateProgram />
          </div>
        </div>
        {loading ? <Loading /> : <DataTable rows={rows} columns={columns} />}
      </section>
    </>
  );
}
export function Dashboard() {
  const { data: programs, error: programsError, loading: programsLoading } = useData<Program[]>("/programs", []);
  const [period, setPeriod] = useState("All time"),
    [hidden, setHidden] = useState(false);
  const { data: metrics, error: metricError } = useData<{
    paid: number;
    due: number;
    registrations: number;
    events: number;
  }>("/dashboard?period=" + encodeURIComponent(period), {
    paid: 0,
    due: 0,
    registrations: 0,
    events: 0,
  });
  const { paid, due, registrations } = metrics;
  return (
    <>
      <main className="dashboard athlentry-dashboard">
        <header className="workspace-heading dashboard-heading">
          <h1>Dashboard</h1>
          <div className="inline dashboard-controls">
          <Select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            options={["All time", "Today"]}
            aria-label="Dashboard reporting period"
          />
          <Button secondary onClick={() => setHidden(!hidden)}>
            {hidden ? "Show data" : "Hide data"}
          </Button>
          <Link className="button secondary" to="/schedule"><CalendarDays size={16} /> Open schedule</Link>
          </div>
        </header>
        <ErrorBox error={metricError} />
        <div className="metric-grid">
          {[
            [Wallet, "Collected", money(paid), "/invoices"],
            [
              Wallet,
              "Payments Due",
              money(due),
              "/invoices?status=Outstanding",
            ],
            [
              ClipboardList,
              "Registrations",
              String(registrations),
              "/registrations",
            ],
            [
              CalendarDays,
              "Games + Events",
              String(metrics.events),
              "/schedule",
            ],
          ].map(([Icon, label, value, to]) => {
            const Glyph = Icon as typeof Wallet;
            return (
              <Link className="metric" to={String(to)} key={String(label)}>
                <Glyph size={21} />
                <div>
                  <span>
                    {String(label)} <small>ⓘ</small>
                  </span>
                  <strong>{hidden ? "••••" : String(value)}</strong>
                </div>
              </Link>
            );
          })}
        </div>
        <div className="workspace-columns">
          <div className="workspace-programs"><ProgramSummary /></div>
          <aside className="workspace-rail" aria-label="Organization actions">
            <section className="workspace-actions">
              <p className="workspace-kicker">NEXT STEPS</p>
              <h2>Keep things moving</h2>
              <Link to="/invoices?status=Outstanding"><Wallet size={18} /><span><strong>Review outstanding balances</strong><small>Follow up on unpaid invoices</small></span><ChevronRight size={16} /></Link>
              <Link to="/registrations"><ClipboardList size={18} /><span><strong>Review registrations</strong><small>Manage enrollments and waitlists</small></span><ChevronRight size={16} /></Link>
              <Link to="/members"><Users size={18} /><span><strong>Find a member</strong><small>Help players and their families</small></span><ChevronRight size={16} /></Link>
            </section>
            <section className="workspace-upcoming">
              <div className="section-heading"><h2>Coming up</h2><Link to="/programs">Programs</Link></div>
              <ErrorBox error={programsError} />
              {programsLoading ? <Loading /> : !programsError && (() => {
                const upcoming = programs.filter(p => p.start_date && new Date(p.start_date.slice(0, 10) + "T00:00:00").getTime() >= new Date().setHours(0,0,0,0) && p.status !== "Unpublished" && p.status !== "Completed").sort((a,b) => a.start_date!.localeCompare(b.start_date!)).slice(0,3);
                return upcoming.length ? upcoming.map(p => <Link className="upcoming-program" key={p.id} to={"/programs/"+p.id}><CalendarDays size={18}/><span><small>{shortDate(p.start_date)}</small><strong>{p.name}</strong></span><ChevronRight size={15}/></Link>) : <p className="workspace-empty">No upcoming program starts. Your schedule has the full picture.</p>;
              })()}
              <Link className="workspace-text-link" to="/schedule">View full schedule <ChevronRight size={14}/></Link>
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}
export function Programs() {
  const { data: terminology } = useTerminology();
  const seasonField = terminology?.fields.find((f) => f.key === "season");
  const { data, error, loading } = useData<Program[]>("/programs", []),
    [params] = useSearchParams();
  const { tab, setTab, search, setSearch, filtered } = useProgramFilter(data);
  const [type, setType] = useState(params.get("type") ?? ""),
    [sport, setSport] = useState(""),
    [season, setSeason] = useState(""),
    [applied, setApplied] = useState({
      type: params.get("type") ?? "",
      sport: "",
      season: "",
    }),
    [expanded, setExpanded] = useState<string[]>([]);
  const matches = filtered.filter(
    (p) =>
      (!applied.type || p.type === applied.type) &&
      (!applied.sport || p.sport === applied.sport) &&
      (!applied.season || p.season === applied.season),
  );
  const rows = matches.filter(
    (p) => !p.parent_id || expanded.includes(p.parent_id),
  );
  return (
    <>
      <PageTitle title="Programs" />
      <main className="legacy-page">
        <ErrorBox error={error} />
        <div className="program-filters">
          <Field label="Program Type">
            <Select
              options={[
                { value: "", label: "Select program type" },
                ...programTypes,
              ]}
              value={type}
              onChange={(e) => setType(e.target.value)}
            />
          </Field>
          <Field label="Sport">
            <Select
              options={[
                { value: "", label: "Select sport" },
                "Soccer",
                "Basketball",
                "Baseball",
                "Volleyball",
              ]}
              value={sport}
              onChange={(e) => setSport(e.target.value)}
            />
          </Field>
          <Field label={seasonField?.label || "Season"}>
            <Select
              options={[
                {
                  value: "",
                  label: "Select " + (seasonField?.label || "season"),
                },
                ...new Set([
                  ...(seasonField?.options.map((o) => o.label) || []),
                  ...data.map((p) => p.season).filter(Boolean),
                ]),
              ]}
              value={season}
              onChange={(e) => setSeason(e.target.value)}
            />
          </Field>
          <Field label="Name">
            <SearchBox value={search} onChange={setSearch} />
          </Field>
          <Button onClick={() => setApplied({ type, sport, season })}>
            Apply filters
          </Button>
          <button
            className="text-button"
            onClick={() => {
              setSearch("");
              setType("");
              setSport("");
              setSeason("");
              setApplied({ type: "", sport: "", season: "" });
            }}
          >
            Clear filters
          </button>
        </div>
        <div className="split-toolbar">
          <Tabs
            items={["Live and Upcoming", "Unpublished", "Completed"]}
            value={tab}
            onChange={setTab}
          />
          <CreateProgram />
        </div>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={rows}
            columns={[
              {
                key: "expand",
                label: "",
                render: (p: Program) =>
                  p.grouped ? (
                    <button
                      className="icon-button"
                      aria-label={"Expand " + p.name}
                      onClick={() =>
                        setExpanded(
                          expanded.includes(p.id)
                            ? expanded.filter((x) => x !== p.id)
                            : [...expanded, p.id],
                        )
                      }
                    >
                      <ChevronRight size={14} />
                    </button>
                  ) : null,
              },
              {
                key: "name",
                label: "Program",
                sort: (p: Program) => p.name,
                render: (p: Program) => (
                  <div className={p.parent_id ? "indent" : ""}>
                    <small className="state">
                      <i className={p.status.toLowerCase()} />
                      {p.status}
                    </small>
                    <Link className="program-name" to={"/programs/" + p.id}>
                      {p.name}
                    </Link>
                    <small>
                      {p.grouped ? "Grouped " : ""}
                      {p.type} / {p.sport} / {p.gender}
                    </small>
                  </div>
                ),
              },
              ...(["invoiced", "paid", "outstanding"] as const).map((key) => ({
                key,
                label: key[0].toUpperCase() + key.slice(1),
                sort: (p: Program) => p[key],
                render: (p: Program) => (
                  <Link to={"/invoices?program_id=" + p.id}>
                    {money(p[key])}
                  </Link>
                ),
              })),
              {
                key: "status",
                label: "Reg. Status",
                render: (p) => (
                  <span className="badge">
                    {p.registration_status || "Scheduled"}
                  </span>
                ),
              },
              {
                key: "start_date",
                label: "Activity Start",
                sort: (p) => p.start_date,
                render: (p) => shortDate(p.start_date),
              },
              {
                key: "registrations",
                label: "Registrations",
                render: (p) => (
                  <div className="registration-counts">
                    <Link to={"/programs/" + p.id + "/teams"}>
                      {p.teams} Teams
                    </Link>
                    <Link to={"/programs/" + p.id + "/people"}>
                      {p.players} Individuals
                    </Link>
                  </div>
                ),
              },
            ]}
          />
        )}
      </main>
    </>
  );
}
const defaults = {
  name: "",
  type: "League",
  sport: "",
  gender: "Any gender",
  level: "",
  season: "",
  status: "Upcoming",
  grouped: false,
  parent_id: null,
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  registration_start: "",
  registration_end: "",
  fee_cents: 0,
  capacity: null,
  waitlist: true,
  public: true,
  description: "",
  audience: "Youth/Family Accounts",
  location_id: "",
  start_visible: true,
  end_visible: true,
  start_tentative: false,
  days: [],
  start_time: "",
  end_time: "",
  sponsor: "",
  host: "",
  format: "",
  registration_status: "",
  registration_password: "",
  code: "",
  integration_codes: [],
  accounting_codes: [],
};
export function ProgramEditor() {
  const terms = useTerminology();
  const { id } = useParams(),
    [params] = useSearchParams();
  const {
    data: existing,
    loading,
    error,
  } = useData<Program | null>(id ? "/programs/" + id : "/programs", null);
  const { data: locations } = useData<Location[]>("/locations", []);
  if (id && loading) return <Loading />;
  if (id && error) return <ErrorBox error={error} />;
  if (terms.loading) return <Loading />;
  if (!terms.data) return <ErrorBox error={terms.error} />;
  return (
    <ProgramForm
      key={id ?? "new"}
      existing={id ? existing : null}
      locations={locations}
      type={params.get("type") ?? "League"}
      terminology={terms.data}
    />
  );
}
function ProgramForm({
  existing,
  locations,
  type,
  terminology,
}: {
  existing: Program | null;
  locations: Location[];
  type: string;
  terminology: Terminology;
}) {
  const navigate = useNavigate(),
    [form, setForm] = useState<any>(
      existing
        ? {
            ...existing,
            grouped: !!existing.grouped,
            public: !!existing.public,
            waitlist: !!existing.waitlist,
          }
        : { ...defaults, type },
    ),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const set = (key: string, value: unknown) =>
    setForm((f: any) => ({ ...f, [key]: value }));
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const p = await api<Program>(
        existing ? "/programs/" + existing.id : "/programs",
        {
          method: existing ? "PUT" : "POST",
          body: JSON.stringify({
            ...form,
            terminology_version: terminology.version,
          }),
        },
      );
      navigate("/programs/" + p.id);
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  }
  const input = (
    key: string,
    extra: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <input
      value={form[key] ?? ""}
      onInput={
        ["date", "time", "datetime-local"].includes(extra.type || "")
          ? (e) => set(key, e.currentTarget.value)
          : undefined
      }
      onChange={(e) => set(key, e.target.value)}
      {...extra}
    />
  );
  const sel = (
    key: string,
    options: (string | { value: string; label: string })[],
    required = false,
  ) => (
    <Select
      required={required}
      value={form[key]}
      onChange={(e) => set(key, e.target.value)}
      options={options}
    />
  );
  const title = existing
    ? "Edit " + form.type.toLowerCase() + " details"
    : "Create " + form.type.toLowerCase();
  return (
    <>
      <PageTitle
        title={title}
        crumbs={[
          { label: "Home", to: "/" },
          ...(existing
            ? [{ label: existing.name, to: "/programs/" + existing.id }]
            : []),
        ]}
      />
      <main className="form-layout">
        <form onSubmit={save} className="program-form">
          <ErrorBox error={error} />
          <Field label={form.type + " name"} required>
            {input("name", {
              required: true,
              maxLength: 100,
              placeholder: "Enter your " + form.type.toLowerCase() + " name…",
            })}
            <small className="counter">{form.name.length}/100</small>
          </Field>
          <Check
            checked={form.public}
            onChange={(e) => set("public", e.target.checked)}
          >
            This {form.type.toLowerCase()} will be visible to the public.
          </Check>
          <div className="grouped-option">
            <Check
              checked={form.grouped}
              disabled={!!existing}
              onChange={(e) => set("grouped", e.target.checked)}
            >
              <strong>This is a grouped program</strong>
              <small>
                There will be one master program, with multiple independent
                sub-programs underneath it.
              </small>
            </Check>
          </div>
          <div className="form-grid four divided">
            {[
              [
                "sport",
                "Sport",
                [
                  "Soccer",
                  "Soccer (Outdoor)",
                  "Basketball",
                  "Baseball",
                  "Softball",
                  "Volleyball",
                  "Football",
                  "Hockey",
                  "Lacrosse",
                  "Tennis",
                  "Multi-sport",
                ],
              ],
              ["gender", "Gender", ["Any gender", "Co-Ed", "Male", "Female"]],
            ].map(([key, label, options]) => (
              <Field label={label as string} required key={key as string}>
                {sel(
                  key as string,
                  [
                    {
                      value: "",
                      label: "Select " + String(label).toLowerCase() + "…",
                    },
                    ...(options as string[]),
                  ],
                  true,
                )}
              </Field>
            ))}
            {["level", "season"].map((key) => {
              const field = terminology.fields.find((f) => f.key === key)!;
              const required = field.required_types.includes(form.type);
              return (
                <Field key={key} label={field.label} required={required}>
                  {sel(
                    key,
                    [
                      {
                        value: "",
                        label: "Select " + field.label.toLowerCase() + "…",
                      },
                      ...termChoices(field, form[key]),
                    ],
                    required,
                  )}
                </Field>
              );
            })}
          </div>
          <FieldGroup
            label={
              "Who is participating in this " + form.type.toLowerCase() + "?"
            }
          >
            <div className="inline">
              {["Youth/Family Accounts", "Adult"].map((v) => (
                <label className="check" key={v}>
                  <input
                    type="radio"
                    name="audience"
                    disabled={!!existing}
                    checked={form.audience === v}
                    onChange={() => set("audience", v)}
                  />
                  {v}
                </label>
              ))}
            </div>
          </FieldGroup>
          <h2 className="form-section">Program Logistics</h2>
          <div className="form-grid">
            <div>
              <Field label="Program start date" required>
                {input("start_date", { type: "date", required: true })}
              </Field>
              <Check
                checked={form.start_visible}
                onChange={(e) => set("start_visible", e.target.checked)}
              >
                Start date is visible
              </Check>
              <Check
                checked={form.start_tentative}
                onChange={(e) => set("start_tentative", e.target.checked)}
              >
                Start date is tentative
              </Check>
            </div>
            <div>
              <Field label="Program end date">
                {input("end_date", { type: "date" })}
              </Field>
              <Check
                checked={form.end_visible}
                onChange={(e) => set("end_visible", e.target.checked)}
              >
                End date is visible
              </Check>
            </div>
            <Field label="Location">
              {sel("location_id", [
                { value: "", label: "Select a location…" },
                ...locations.map((l) => ({ value: l.id, label: l.name })),
              ])}
            </Field>
            <Field label="Program status">
              {sel("status", ["Upcoming", "Live", "Unpublished", "Completed"])}
            </Field>
            <FieldGroup label="Program days of week">
              <div className="day-selector">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <button
                    type="button"
                    key={d}
                    aria-pressed={form.days.includes(d)}
                    onClick={() =>
                      set(
                        "days",
                        form.days.includes(d)
                          ? form.days.filter((x: string) => x !== d)
                          : [...form.days, d],
                      )
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
            </FieldGroup>
            <div className="form-grid">
              <Field label="Start time">
                {input("start_time", { type: "time" })}
              </Field>
              <Field label="End time">
                {input("end_time", { type: "time" })}
              </Field>
            </div>
            <Field label="Sponsor">
              {input("sponsor", {
                maxLength: 255,
                placeholder: "Enter sponsor name",
              })}
            </Field>
            <Field label="Host">
              {input("host", {
                maxLength: 255,
                placeholder: "Enter host name",
              })}
            </Field>
            <Field label={form.type + " format"}>
              {input("format", { maxLength: 255, placeholder: "Enter format" })}
            </Field>
          </div>
          <h2 className="form-section">Registration details</h2>
          <div className="form-grid">
            <Field label="Registration start date">
              {input("registration_start", { type: "date" })}
            </Field>
            <Field label="Registration end date">
              {input("registration_end", { type: "date" })}
            </Field>
            <Field label="Registration status">
              {sel("registration_status", [
                { value: "", label: "No status override…" },
                "Open",
                "Closed",
                "Coming Soon",
                "Sold Out",
              ])}
            </Field>
            <Field label="Registration password">
              {input("registration_password", {
                maxLength: 64,
                placeholder: "Enter registration password",
              })}
            </Field>
          </div>
          <h2 className="form-section">Program description</h2>
          <Field label="Program description">
            <textarea
              rows={8}
              value={form.description}
              maxLength={10000}
              onChange={(e) => set("description", e.target.value)}
            />
            <small className="counter">{form.description.length}/10000</small>
          </Field>
          <h2 className="form-section">Program codes</h2>
          <Field label="Program code">
            {input("code", {
              maxLength: 40,
              placeholder: "Enter your program code…",
            })}
          </Field>
          {terminology.fields
            .filter((f) => f.key.startsWith("accounting_") && f.enabled)
            .map((field) => {
              const index = Number(field.key.slice(-1)) - 1;
              return (
                <Field key={field.key} label={field.label}>
                  <Select
                    value={form.accounting_codes?.[index] || ""}
                    options={[
                      {
                        value: "",
                        label: "Select " + field.label.toLowerCase() + "…",
                      },
                      ...termChoices(field, form.accounting_codes?.[index]),
                    ]}
                    onChange={(e) => {
                      const codes = Array.from(
                        { length: 5 },
                        (_, i) => form.accounting_codes?.[i] || "",
                      );
                      codes[index] = e.target.value;
                      set("accounting_codes", codes);
                    }}
                  />
                </Field>
              );
            })}
          <div className="form-actions">
            <Link to={existing ? "/programs/" + existing.id : "/programs"}>
              Cancel
            </Link>
            <Button disabled={saving}>
              {saving
                ? "Saving…"
                : existing
                  ? "Save changes"
                  : "Create " + form.type.toLowerCase()}
            </Button>
          </div>
        </form>
        <aside className="help-sidebar">
          <h3>Need help?</h3>
          <p>
            Programs bring registration, teams, schedules, and payments
            together.
          </p>
          <h4>Program details</h4>
          <p>
            Set your dates and public visibility. Grouped programs organize
            multiple independent divisions or age groups.
          </p>
          <h4>Registration</h4>
          <p>
            Choose when registration opens and closes. Configure fees and
            capacity in Registration Options after creating your program.
          </p>
        </aside>
      </main>
    </>
  );
}
export function ProgramNav({
  id,
  active = "Home",
}: {
  id: string;
  active?: string;
}) {
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  return (
    <nav className="program-nav">
      {[
        ["Home", ""],
        ["Settings", "/edit"],
        ["People", "/people"],
        ["Teams", "/teams"],
        ["Schedule", "/schedule"],
        ["Standings", "/standings"],
        ["Products", "/products"],
        ["Invoices", "/invoices"],
      ].map(([name, suffix]) =>
        name === "People" ? <div key={name} className="program-team-navigation" onMouseEnter={()=>setPeopleOpen(true)} onMouseLeave={()=>setPeopleOpen(false)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setPeopleOpen(false)}} onKeyDown={e=>{if(e.key==="Escape"){setPeopleOpen(false);e.stopPropagation()}}}>
          <Link className={active===name?"active":""} to={`/programs/${id}/people`}>People</Link>
          <button type="button" aria-label="People navigation" aria-expanded={peopleOpen} onClick={()=>setPeopleOpen(v=>!v)}>▾</button>
          {peopleOpen&&<div className="program-team-submenu"><Link to={`/programs/${id}/people`} onClick={()=>setPeopleOpen(false)}>Players</Link><Link to={`/programs/${id}/staff`} onClick={()=>setPeopleOpen(false)}>Staff</Link></div>}
        </div> : name === "Teams" ? (
          <div
            key={name}
            className="program-team-navigation"
            onMouseEnter={() => setTeamsOpen(true)}
            onMouseLeave={() => setTeamsOpen(false)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget))
                setTeamsOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTeamsOpen(false);
                e.stopPropagation();
              }
            }}
          >
            <Link
              className={active === name ? "active" : ""}
              to={`/programs/${id}/teams`}
            >
              Teams
            </Link>
            <button
              type="button"
              aria-label="Team navigation"
              aria-expanded={teamsOpen}
              onClick={() => setTeamsOpen(true)}
            >
              ▾
            </button>
            {teamsOpen && (
              <div className="program-team-submenu">
                {[
                  ["Team List", "teams"],
                  ["Roster Settings", "roster-settings"],
                  ["Team Builder", "team-builder"],
                ].map(([label, path]) => (
                  <Link
                    key={path}
                    to={`/programs/${id}/${path}`}
                    onClick={() => setTeamsOpen(false)}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Link
            key={name}
            className={active === name ? "active" : ""}
            to={
              name === "Invoices"
                ? "/invoices?program_id=" + id
                : "/programs/" + id + suffix
            }
          >
            {name}
          </Link>
        ),
      )}
    </nav>
  );
}
export function ProgramHome() {
  const { data: terminology } = useTerminology();
  const { id } = useParams();
  const {
    data: p,
    error,
    loading,
  } = useData<Program | null>("/programs/" + id, null);
  if (loading) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  return (
    <>
      <header className="workspace-heading program-workspace-heading">
        <div><Link className="workspace-kicker" to="/programs">PROGRAMS / OVERVIEW</Link><h1>{p.name}</h1><p>{[p.sport, p.type, p.season].filter(Boolean).join(" · ")} <span className="program-status-label">{p.status}</span></p></div>
        <Link className="button secondary" to={"/programs/" + p.id + "/edit"}><Settings2 size={16}/> Edit program</Link>
      </header>
      <ProgramNav id={p.id} />
      <div className="program-home athlentry-program-home">
        <aside>
          <div className="detail-block">
            <h4>Program State</h4>
            <span className="state">
              <i className={p.status.toLowerCase()} />
              {p.status}
            </span>
            <h4>Registration Status</h4>
            <span>
              {p.registration_status || "No status override"}
            </span>
            <div className="action-links">
              <Link to={"/programs/" + p.id + "/edit"}>
                Edit program details »
              </Link>
              <Link to={"/programs/" + p.id + "/options"}>
                Registration Options »
              </Link>
              <Link to={"/invoices?program_id=" + p.id}>
                View program invoices
              </Link>
            </div>
          </div>
          <div className="section-heading">
            <h3>Main Details</h3>
            <Link to={"/programs/" + p.id + "/edit"}>edit</Link>
          </div>
          {[
            ["Adult/Youth", p.audience],
            ["Program Type", p.type],
            ["Sport", p.sport],
            ["Gender", p.gender],
            [
              terminology?.fields.find((f) => f.key === "level")?.label ||
                "Level",
              p.level,
            ],
            [
              terminology?.fields.find((f) => f.key === "season")?.label ||
                "Season",
              p.season,
            ],
            ...(terminology?.fields
              .filter((f) => f.key.startsWith("accounting_") && f.enabled)
              .map((f) => [
                f.label,
                p.accounting_codes?.[Number(f.key.slice(-1)) - 1] || "—",
              ]) || []),
            ["Takes place on days", p.days?.join(" · ")],
            ["Format", p.format],
            [
              "Registration Period",
              shortDate(p.registration_start) +
                " – " +
                shortDate(p.registration_end),
            ],
            ["Start Date", shortDate(p.start_date)],
            ["End Date", shortDate(p.end_date)],
          ].map(([label, value]) => (
            <div className="detail-block" key={label}>
              <h4>{label}</h4>
              <span>{value || "—"}</span>
            </div>
          ))}
          <h3>Registration Options</h3>
          <div className="detail-block">
            <h4>Standard Fees</h4>
            {money(p.fee_cents)}
            <h4>Capacity</h4>
            {p.capacity ?? "Unlimited"}
            <h4>Waiting List</h4>
            {p.waitlist ? "Enabled" : "Disabled"}
          </div>
        </aside>
        <section>
          <div className="form-grid">
            <div className="summary-panel">
              <h3>
                <CalendarDays size={16} />
                Timeline
              </h3>
              <div>
                {[
                  [p.registration_start, "Registration opens"],
                  [p.registration_end, "Registration closed"],
                  [p.start_date, "Activity Starts"],
                  [p.end_date, "Activity Ends"],
                ].map(([date, label]) => (
                  <p key={label}>
                    <time>{shortDate(date)}</time>
                    {label}
                  </p>
                ))}
              </div>
            </div>
            <div className="summary-panel">
              <h3>
                <Wallet size={16} />
                Payment Activity
              </h3>
              <div>
                <p>
                  <span>Paid</span>
                  <strong>{money(p.paid)}</strong>
                </p>
                <p>
                  <span>Invoiced</span>
                  <strong>{money(p.invoiced)}</strong>
                </p>
              </div>
            </div>
          </div>
          <div className="summary-panel registration-activity">
            <h3>
              <ClipboardList size={16} />
              Registration Activity
            </h3>
            {[
              ["Free Agents", p.free_agents],
              ["All Registrants", p.players],
              ["Teams", p.teams],
            ].map(([label, count]) => (
              <div className="activity-row" key={label}>
                <Link
                  to={
                    "/programs/" +
                    p.id +
                    "/" +
                    (label === "Teams" ? "teams" : "people")
                  }
                >
                  {count} {label}
                </Link>
                <ChevronRight size={18} aria-hidden="true" />
              </div>
            ))}
          </div>
          {!!p.grouped && (
            <section className="panel">
              <h3>Sub-programs</h3>
              <SubPrograms parentId={p.id} />
            </section>
          )}
        </section>
      </div>
    </>
  );
}
function SubPrograms({ parentId }: { parentId: string }) {
  const { data } = useData<Program[]>("/programs", []);
  return (
    <>
      {data
        .filter((p) => p.parent_id === parentId)
        .map((p) => (
          <Link className="suggestion" key={p.id} to={"/programs/" + p.id}>
            {p.name}
            <ChevronRight size={14} />
          </Link>
        ))}
    </>
  );
}
