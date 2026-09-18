import { MemberAccountAccess } from "./account-access";
import { MemberCardPreview } from "./member-card";
import { useTerminology } from "./terminology";
import type { StaffRoleSettings } from "./staff-roles";
import { useCallback, useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Pencil, Archive, RotateCcw, UserRound, X, Plus } from "lucide-react";
import { api, csv, money, shortDate } from "./api";
import {
  RegistrationQuestions,
  ProfileQuestions,
  ProfileAnswerRecord,
  RegistrationRecord,
} from "./forms";
import type { RegistrationFormValues } from "./forms";
import {
  Button,
  Check,
  DataTable,
  Empty,
  ErrorBox,
  ExportButton,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  Tabs,
  useData,
} from "./components";
import type {
  Credit,
  Household,
  Invoice,
  MemberRegistration,
  Person,
  Program,
  Team,
} from "./types";

export const memberName = (p: Pick<Person, "first_name" | "last_name">) =>
  `${p.first_name} ${p.last_name}`;
const adult = (p: Person) =>
  p.birthdate
    ? (new Date().getTime() - new Date(p.birthdate).getTime()) / 31557600000 >=
      18
    : p.kind !== "player";
const fullName = (p: Person) => (
  <>
    <Link to={"/members/" + p.id}>{memberName(p)}</Link>
    <small>{p.email}</small>
    <small>{p.kind === "staff" ? "Staff" : "Member"}</small>
    {p.household_id && (
      <Link className="small-link" to={"/households/" + p.household_id}>
        {p.household_name ?? "Family Account"}
      </Link>
    )}
  </>
);
export function Members() {
  const { data, loading, error, reload } = useData<Person[]>(
    "/people?archived=1",
    [],
  );
  const initial = {
    gender: "",
    type: "",
    search: "",
    activity: "",
    email: "",
    sort: "Last Login",
    reverse: true,
    archived: false,
  };
  const [draft, setDraft] = useState(initial),
    [filters, setFilters] = useState(initial),
    [removing, setRemoving] = useState<Person | null>(null),
    [actionError, setActionError] = useState("");
  const close = useCallback(() => setRemoving(null), []);
  const recent = (value: string | undefined) =>
    !!value && Date.parse(value) > Date.now() - 30 * 86400000;
  const rows = data
    .filter(
      (p) =>
        Boolean(p.archived_at) === filters.archived &&
        (!filters.gender || p.gender === filters.gender) &&
        (!filters.type || (filters.type === "Adult" ? adult(p) : !adult(p))) &&
        (!filters.email || (p.email_status ?? "Active") === filters.email) &&
        (!filters.activity ||
          (filters.activity === "Active"
            ? recent(p.last_login)
            : recent(p.created_at))) &&
        `${memberName(p)} ${p.email}`
          .toLowerCase()
          .includes(filters.search.toLowerCase()),
    )
    .sort((a, b) => {
      const key =
        filters.sort === "Name"
          ? "last_name"
          : filters.sort === "Date Joined"
            ? "created_at"
            : "last_login";
      return (
        String(a[key] ?? "").localeCompare(String(b[key] ?? "")) *
        (filters.reverse ? -1 : 1)
      );
    });
  const active = data.filter((p) => !p.archived_at);
  return (
    <>
      <PageTitle title="Members" />
      <main className="wide-page">
        <ErrorBox error={error || actionError} />
        <div className="member-metrics">
          {[
            ["Adult Members", active.filter(adult).length],
            ["Child Members", active.filter((p) => !adult(p)).length],
            [
              "Active Members — Past 30 Days",
              active.filter((p) => recent(p.last_login)).length,
            ],
            [
              "New Members — Past 30 Days",
              active.filter((p) => recent(p.created_at)).length,
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <h4>{label}</h4>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <section className="content-page directory-panel">
          <div className="toolbar directory-actions">
            <h2>Member directory</h2>
            <Link className="button" to="/members/new">Add member</Link>
            <Link className="button secondary" to="/households/new">Add group account</Link>
            <ExportButton
              onClick={() =>
                csv(
                  "members",
                  [
                    "Member ID",
                    "First Name",
                    "Last Name",
                    "Email",
                    "Gender",
                    "Birthdate",
                    "Joined",
                    "Last Login",
                  ],
                  rows.map((p) => [
                    p.id,
                    p.first_name,
                    p.last_name,
                    p.email,
                    p.gender,
                    p.birthdate,
                    p.created_at,
                    p.last_login ?? "",
                  ]),
                )
              }
            />
          </div>
          <form
            className="legacy-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setFilters({ ...draft });
            }}
          >
            <div className="directory-filter-grid">
              <label className="field"><span>Gender</span>
              <Select
                aria-label="Gender filter"
                options={[
                  { value: "", label: "any Gender" },
                  "Male",
                  "Female",
                  "Non-binary",
                  "Unknown",
                ]}
                value={draft.gender}
                onChange={(e) => setDraft({ ...draft, gender: e.target.value })}
              /></label>
              <label className="field"><span>Member type</span>
              <Select
                aria-label="Member type filter"
                options={[
                  { value: "", label: "any member type" },
                  "Adult",
                  "Child",
                ]}
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value })}
              /></label>
              <label className="field"><span>Name or email</span>
              <input
                aria-label="Member name or email"
                value={draft.search}
                onChange={(e) => setDraft({ ...draft, search: e.target.value })}
              /></label>
              <label className="field"><span>Activity</span>
              <Select
                aria-label="Member activity"
                options={[
                  { value: "", label: "all members" },
                  { value: "Active", label: "active in past 30 days" },
                  { value: "New", label: "new in past 30 days" },
                ]}
                value={draft.activity}
                onChange={(e) =>
                  setDraft({ ...draft, activity: e.target.value })
                }
              /></label>
              <label className="field"><span>Email status</span>
              <Select
                aria-label="Email status filter"
                options={[
                  { value: "", label: "any status" },
                  "Active",
                  "Unsubscribed",
                  "Bounced",
                ]}
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              /></label>
            </div>
            <div className="inline wrap">
              <span>Sort by</span>
              <Select
                aria-label="Member sort"
                options={["Last Login", "Date Joined", "Name"]}
                value={draft.sort}
                onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
              />
              <Check
                checked={draft.reverse}
                onChange={(e) =>
                  setDraft({ ...draft, reverse: e.target.checked })
                }
              >
                Reverse Order
              </Check>
              <Check
                checked={draft.archived}
                onChange={(e) =>
                  setDraft({ ...draft, archived: e.target.checked })
                }
              >
                Archived members
              </Check>
              <Button>Apply filters</Button>
            </div>
          </form>
          {loading ? (
            <Loading />
          ) : (
            <DataTable
              pagination
              rows={rows}
              columns={[
                { key: "name", label: "Member", render: fullName },
                { key: "gender", label: "Gender" },
                {
                  key: "birthdate",
                  label: "Birthdate",
                  render: (p) => shortDate(p.birthdate),
                },
                {
                  key: "created_at",
                  label: "Date Joined",
                  render: (p) => shortDate(p.created_at),
                },
                {
                  key: "last_login",
                  label: "Last Login",
                  render: (p) => shortDate(p.last_login ?? ""),
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (p) => (
                    <div className="row-actions">
                      <Link
                        className="square-action"
                        title={"Edit " + memberName(p)}
                        to={"/members/" + p.id + "/edit"}
                      >
                        <Pencil size={13} />
                      </Link>
                      <button
                        className="square-action"
                        aria-label={
                          (p.archived_at ? "Restore " : "Archive ") +
                          memberName(p)
                        }
                        onClick={async () => {
                          if (!p.archived_at) return setRemoving(p);
                          try {
                            await api("/people/" + p.id + "/archive", {
                              method: "PATCH",
                              body: JSON.stringify({ archived: false }),
                            });
                            reload();
                          } catch (e) {
                            setActionError((e as Error).message);
                          }
                        }}
                      >
                        {p.archived_at ? (
                          <RotateCcw size={13} />
                        ) : (
                          <Archive size={13} />
                        )}
                      </button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </section>
      </main>
      {removing && (
        <Modal title="Archive member" onClose={close}>
          <div className="modal-body">
            <p>
              Archive {memberName(removing)}? Their registrations, invoices, and
              family relationships stay in the account. You can restore them
              from Archived members.
            </p>
            <ErrorBox error={actionError} />
            <div className="form-actions">
              <Button secondary onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await api("/people/" + removing.id + "/archive", {
                      method: "PATCH",
                      body: JSON.stringify({ archived: true }),
                    });
                    reload();
                    close();
                  } catch (e) {
                    setActionError((e as Error).message);
                  }
                }}
              >
                Archive Member
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function MemberEditor() {
  const [search] = useSearchParams();
  const staffProgram = search.get("staff_program");
  const registrationContext = staffProgram
    ? "?staff_program=" + encodeURIComponent(staffProgram)
    : "";
  const { id } = useParams(),
    navigate = useNavigate();
  return (
    <>
      <PageTitle title={id ? "Edit Site Member" : "Add New Site Member"} />
      <main className="content-page">
        {id ? (
          <LoadedMemberForm
            id={id}
            done={(p) => navigate("/members/" + p.id + registrationContext)}
            cancel={() => navigate("/members/" + id)}
          />
        ) : (
          <MemberForm
            done={(p) => navigate("/members/" + p.id + registrationContext)}
            cancel={() =>
              navigate(
                staffProgram
                  ? "/programs/" + encodeURIComponent(staffProgram) + "/staff"
                  : "/members",
              )
            }
          />
        )}
      </main>
    </>
  );
}
function LoadedMemberForm({
  id,
  done,
  cancel,
}: {
  id: string;
  done: (p: Person) => void;
  cancel: () => void;
}) {
  const { data, error, loading } = useData<Person | null>(
    "/people/" + id,
    null,
  );
  return loading ? (
    <Loading />
  ) : data ? (
    <MemberForm key={data.id} initial={data} done={done} cancel={cancel} />
  ) : (
    <ErrorBox error={error} />
  );
}
export function MemberForm({
  initial,
  householdId,
  householdRole,
  done,
  cancel,
}: {
  initial?: Person;
  householdId?: string;
  householdRole?: string;
  done: (p: Person) => void;
  cancel: () => void;
}) {
  const [form, setForm] = useState({
      first_name: initial?.first_name ?? "",
      last_name: initial?.last_name ?? "",
      gender: initial?.gender ?? "Unknown",
      birthdate: initial?.birthdate ?? "",
      email: initial?.email ?? "",
      phone: initial?.phone ?? "",
      secondary_email: initial?.secondary_email ?? "",
      kind:
        initial?.kind ?? (householdRole === "Supervisor" ? "parent" : "player"),
      address: initial?.address ?? "",
      city: initial?.city ?? "",
      state: initial?.state ?? "",
      postal_code: initial?.postal_code ?? "",
      marketing_opt_in: initial?.marketing_opt_in ?? false,
      sms_opt_in: initial?.sms_opt_in ?? false,
      biography: initial?.biography ?? "",
      notes: initial?.notes ?? "",
      email_status: initial?.email_status ?? "Active",
    }),
    [questions, setQuestions] = useState<
      RegistrationFormValues & { context: string }
    >({
      answers: {},
      waiver_acceptances: [],
      form_version: 0,
      has_waivers: false,
      context: "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const questionContext = [initial?.id, form.birthdate, form.kind].join(":");
  const field = (
    key: Exclude<keyof typeof form, "marketing_opt_in" | "sms_opt_in">,
    label: string,
    type = "text",
    required = false,
  ) => (
    <Field label={label} required={required}>
      <input
        type={type}
        required={required}
        maxLength={key === "phone" ? 40 : 255}
        value={form[key]}
        onInput={
          type === "date"
            ? (e) => setForm({ ...form, [key]: e.currentTarget.value })
            : undefined
        }
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <form
      className="member-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const p = await api<Person>(
            "/people" + (initial ? "/" + initial.id : ""),
            {
              method: initial ? "PUT" : "POST",
              body: JSON.stringify({
                ...form,
                profile_answers: questions.answers,
                profile_form_version: questions.form_version,
                profile_record_version: questions.profile_record_version,
                ...(householdId
                  ? { household_id: householdId, household_role: householdRole }
                  : {}),
              }),
            },
          );
          done(p);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <h2>Personal Info</h2>
      <div className="form-grid compact-fields">
        {field("first_name", "First Name", "text", true)}
        {field("last_name", "Last Name", "text", true)}
      </div>
      <div className="compact-fields form-grid">
        <Field label="Gender">
          <Select
            options={["Unknown", "Male", "Female", "Non-binary"]}
            value={form.gender}
            onChange={(e) => setForm({ ...form, gender: e.target.value })}
          />
        </Field>
        {field("birthdate", "Birth Date", "date")}
      </div>
      <div className="compact-fields">
        {field("phone", "Mobile Number", "tel")}
      </div>
      {field("email", "Email", "email")}
      {field("secondary_email", "Secondary Email", "email")}
      <Check
        checked={form.sms_opt_in}
        onChange={(e) => setForm({ ...form, sms_opt_in: e.target.checked })}
      >
        This member has consented to receive text messages.
      </Check>
      <Field label="Email delivery status">
        <Select
          value={form.email_status}
          onChange={(e) =>
            setForm({
              ...form,
              email_status: e.target.value as typeof form.email_status,
            })
          }
          options={["Active", "Unsubscribed", "Bounced"]}
        />
      </Field>
      <div className="compact-fields">
        <Field label="Member Type">
          <Select
            aria-label="Member Type"
            options={[
              { value: "player", label: "Player" },
              { value: "parent", label: "Parent" },
              { value: "staff", label: "Staff" },
            ]}
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          />
        </Field>
      </div>
      <h2>Additional Info</h2>
      <p className="muted">As an admin, you may skip these fields.</p>
      <div className="compact-fields">{field("address", "Address")}</div>
      <div className="form-grid three compact-address">
        {field("city", "City")}
        {field("state", "State / Province")}
        {field("postal_code", "Zip / Postal Code")}
      </div>
      <Check
        checked={form.marketing_opt_in}
        onChange={(e) =>
          setForm({ ...form, marketing_opt_in: e.target.checked })
        }
      >
        Email this member about upcoming activities and promotions.
      </Check>
      <Field label="Biography">
        <textarea
          rows={4}
          maxLength={10000}
          value={form.biography}
          onChange={(e) => setForm({ ...form, biography: e.target.value })}
        />
      </Field>
      <ProfileQuestions
        personId={initial?.id}
        birthdate={form.birthdate}
        kind={form.kind}
        onChange={(value) =>
          setQuestions({ ...value, context: questionContext })
        }
      />
      <div className="form-actions start">
        <Button
          disabled={
            busy ||
            !questions.form_version ||
            questions.context !== questionContext
          }
        >
          {busy ? "Saving…" : initial ? "Save Site Member" : "Add Site Member"}
        </Button>
        <Button secondary type="button" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Profile = Person & {
  households: Household[];
  registrations: MemberRegistration[];
  invoices: Invoice[];
  credits: Credit[];
  waivers: {
    id: string;
    registration_id: string;
    waiver_version: number;
    accepted_at: string;
    program_id: string;
    program_name: string;
    name: string;
    signer_name: string;
  }[];
};
export function MemberProfile({ consoleRole }: { consoleRole: string }) {
  const { id } = useParams(),
    {
      data: p,
      loading,
      error,
      reload,
    } = useData<Profile | null>("/people/" + id, null),
    [tab, setTab] = useState("Registrations"),
    [past, setPast] = useState("Current Registrations"),
    [notes, setNotes] = useState(false),
    [card, setCard] = useState(false),
    [waiverRecord, setWaiverRecord] = useState(""),
    [noteValue, setNoteValue] = useState(""),
    [actionError, setActionError] = useState("");
  const closeNotes = useCallback(() => setNotes(false), []);
  const closeCard = useCallback(() => setCard(false), []);
  const closeWaiver = useCallback(() => setWaiverRecord(""), []);
  if (loading) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  const registrations = p.registrations.filter(
    (r) =>
      (r.program_status === "Completed") === (past === "Past Registrations"),
  );
  return (
    <>
      <PageTitle title={`${p.last_name}, ${p.first_name}`} />
      <div className="profile-actions">
        <Link to={"/messaging/compose?person=" + p.id}>Message Member</Link>
        {p.households.map((h) => (
          <Link key={h.id} to={"/households/" + h.id}>
            {h.name}
          </Link>
        ))}
        <Link to={"/members/" + p.id + "/edit"}>Edit Member Profile</Link>
        <button onClick={() => setCard(true)}>Generate Member Card</button>
      </div>
      <main className="member-profile">
        <aside className="profile-sidebar">
          <div className="profile-avatar">
            <UserRound size={90} />
          </div>
          <h4>Email</h4>
          <p>{p.email || "—"}</p>
          {p.email_status && p.email_status !== "Active" && (
            <small>{p.email_status}</small>
          )}
          <h4>Mobile Phone</h4>
          <p>{p.phone || "—"}</p>
          <h4>Address</h4>
          <p>
            {p.address || "—"}
            <br />
            {[p.city, p.state, p.postal_code].filter(Boolean).join(", ")}
          </p>
          <h2>Notes</h2>
          <p className="preserve-lines">{p.notes}</p>
          <Button
            onClick={() => {
              setNoteValue(p.notes ?? "");
              setNotes(true);
            }}
          >
            Edit Notes
          </Button>
          <h2>Account Activity</h2>
          <ul>
            <li>Joined on {shortDate(p.created_at)}</li>
            <li>Last logged in: {shortDate(p.last_login ?? "")}</li>
          </ul>
          <h2>Credits &amp; Invoices</h2>
          <p>
            Credit:{" "}
            {money(
              p.credits
                .filter(
                  (c) =>
                    !c.expires ||
                    c.expires >= new Date().toLocaleDateString("en-CA"),
                )
                .reduce((sum, c) => sum + c.balance_cents, 0),
            )}
          </p>
          <p>
            Balance:{" "}
            {money(
              p.invoices
                .filter((i) => !i.voided)
                .reduce((sum, i) => sum + i.total_cents - i.paid_cents, 0),
            )}
          </p>
          <Link to={"/credits?person_id=" + p.id}>View Credits</Link>
        </aside>
        <section className="profile-main">
          <MemberAccountAccess personId={p.id} email={p.email || ""} role={consoleRole} />
          <ErrorBox error={error || actionError} />
          <Tabs
            items={["Registrations", "Waivers", "Invoices"]}
            value={tab}
            onChange={setTab}
          />
          {tab === "Registrations" ? (
            <>
              <RegisterMember person={p} done={reload} />
              <Tabs
                items={["Current Registrations", "Past Registrations"]}
                value={past}
                onChange={setPast}
              />
              <MemberRegistrationTable rows={registrations} />
            </>
          ) : tab === "Waivers" ? (
            <>
              <p>Waiver acceptance recorded for this member’s registrations.</p>
              <DataTable
                rows={[
                  ...(p.waivers || []),
                  ...p.registrations
                    .filter(
                      (r) =>
                        r.waiver_accepted_at &&
                        !p.waivers?.some((w) => w.registration_id === r.id),
                    )
                    .map((r) => ({
                      id: r.id,
                      registration_id: r.id,
                      waiver_version: 0,
                      accepted_at: r.waiver_accepted_at!,
                      program_id: r.program_id,
                      program_name: r.program_name,
                      name: "Legacy registration waiver",
                      signer_name: "Not recorded",
                    })),
                ]}
                columns={[
                  {
                    key: "program_name",
                    label: "Program",
                    render: (r) => (
                      <Link to={"/programs/" + r.program_id}>
                        {r.program_name}
                      </Link>
                    ),
                  },
                  {
                    key: "waiver",
                    label: "Waiver",
                    render: (w) => (
                      <button
                        className="text-button"
                        onClick={() => setWaiverRecord(w.registration_id)}
                      >
                        {w.name}
                        {w.waiver_version
                          ? ` · Version ${w.waiver_version}`
                          : ""}
                      </button>
                    ),
                  },
                  { key: "signer_name", label: "Signer" },
                  {
                    key: "accepted_at",
                    label: "Accepted",
                    render: (r) => shortDate(r.accepted_at),
                  },
                ]}
              />
            </>
          ) : (
            <DataTable
              rows={p.invoices}
              columns={[
                {
                  key: "number",
                  label: "Invoice",
                  render: (i) => (
                    <Link to={"/invoices/" + i.id}>#{i.number}</Link>
                  ),
                },
                { key: "description", label: "Description" },
                {
                  key: "created_at",
                  label: "Date",
                  render: (i) => shortDate(i.created_at),
                },
                {
                  key: "total_cents",
                  label: "Total",
                  render: (i) => money(i.total_cents),
                },
                {
                  key: "balance",
                  label: "Balance",
                  render: (i) => money(i.total_cents - i.paid_cents),
                },
              ]}
            />
          )}
          <ProfileAnswerRecord personId={p.id} />
        </section>
      </main>
      {waiverRecord && (
        <RegistrationRecord
          registrationId={waiverRecord}
          onClose={closeWaiver}
        />
      )}
      {card && (
        <Modal title="Member Card" onClose={closeCard}>
          <div className="modal-body">
            <MemberCardPreview person={p} onClose={closeCard} />
          </div>
        </Modal>
      )}
      {notes && (
        <Modal title="Edit Notes" onClose={closeNotes}>
          <form
            className="modal-body"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/people/" + p.id, {
                  method: "PUT",
                  body: JSON.stringify({ ...p, notes: noteValue }),
                });
                closeNotes();
                reload();
              } catch (e) {
                setActionError((e as Error).message);
              }
            }}
          >
            <Field label="Internal Notes">
              <textarea
                rows={8}
                maxLength={10000}
                value={noteValue}
                onChange={(e) => setNoteValue(e.target.value)}
              />
            </Field>
            <ErrorBox error={actionError} />
            <div className="form-actions">
              <Button secondary type="button" onClick={closeNotes}>
                Cancel
              </Button>
              <Button>Save Notes</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function RegisterMember({
  person,
  done,
}: {
  person: Profile;
  done: () => void;
}) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const originProgram = search.get("staff_program") || "";
  const roleSettings = useData<StaffRoleSettings>("/settings/staff-roles", {
    version: 1,
    roles: [],
  });
  const { data: programs } = useData<Program[]>("/programs", []),
    [program, setProgram] = useState(""),
    [staffProgram, setStaffProgram] = useState(originProgram),
    [pending, setPending] = useState(false),
    [staff, setStaff] = useState(false),
    [team, setTeam] = useState(""),
    [role, setRole] = useState("Coach"),
    [code, setCode] = useState(""),
    [questions, setQuestions] = useState<
      RegistrationFormValues & { context: string }
    >({
      answers: {},
      waiver_acceptances: [],
      form_version: 0,
      has_waivers: false,
      context: "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const selectedProgram = staff ? staffProgram : program;
  const teams = useData<Team[]>(
    "/teams?program_id=" + encodeURIComponent(selectedProgram || "none"),
    [],
  );
  const selectedRole = staff ? role : team ? "Team Player" : "Free Agent";
  const questionContext = [selectedProgram, person.id, selectedRole].join(":");
  const close = useCallback(() => setPending(false), []),
    options = [
      { value: "", label: "— all programs —" },
      ...programs
        .filter((p) => !p.grouped && p.status !== "Completed")
        .map((p) => ({ value: p.id, label: p.name })),
    ];
  useEffect(() => {
    if (
      !roleSettings.loading &&
      !roleSettings.data.roles.some((r) => r.name === role)
    )
      setRole(roleSettings.data.roles[0]?.name || "");
  }, [roleSettings.data, roleSettings.loading, role]);
  return (
    <>
      {["Program Registration", "Program Staff Registration"].map(
        (label, i) => (
          <section className="profile-register" key={label}>
            <h2>{label}</h2>
            <div className="inline wrap">
              <span>Add to Program:</span>
              <Select
                aria-label={label}
                options={options}
                value={i ? staffProgram : program}
                onChange={(e) =>
                  i
                    ? setStaffProgram(e.target.value)
                    : setProgram(e.target.value)
                }
              />
              <Button
                disabled={!(i ? staffProgram : program)}
                onClick={() => {
                  setStaff(!!i);
                  setError("");
                  setPending(true);
                  setTeam("");
                  setCode("");
                  setQuestions({
                    answers: {},
                    waiver_acceptances: [],
                    form_version: 0,
                    has_waivers: false,
                    context: "",
                  });
                }}
              >
                Add
              </Button>
            </div>
          </section>
        ),
      )}
      {pending && (
        <Modal title="Confirm Program Registration" onClose={close}>
          <form
            className="modal-body"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("/registrations", {
                  method: "POST",
                  body: JSON.stringify({
                    person_id: person.id,
                    program_id: staff ? staffProgram : program,
                    team_id: team || null,
                    role: staff ? role : team ? "Team Player" : "Free Agent",
                    discount_code: code,
                    answers: questions.answers,
                    waiver_acceptances: questions.waiver_acceptances,
                    form_version: questions.form_version,
                  }),
                });
                close();
                done();
                if (staff && originProgram === staffProgram)
                  navigate(
                    "/programs/" + encodeURIComponent(staffProgram) + "/staff",
                  );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              Register <strong>{memberName(person)}</strong> for{" "}
              <strong>
                {
                  programs.find(
                    (p) => p.id === (staff ? staffProgram : program),
                  )?.name
                }
              </strong>
              .
            </p>
            <ErrorBox error={error} />
            <ErrorBox
              error={teams.error || (staff ? roleSettings.error : "")}
            />
            {staff && (
              <Field label="Staff Role">
                <Select
                  aria-label="Staff Role"
                  disabled={roleSettings.loading || !!roleSettings.error}
                  options={roleSettings.data.roles.map((r) => r.name)}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
              </Field>
            )}
            <Field label="Team">
              <Select
                aria-label="Registration team"
                disabled={teams.loading || !!teams.error}
                options={[
                  { value: "", label: "No team" },
                  ...teams.data
                    .filter(
                      (t) => t.program_id === (staff ? staffProgram : program),
                    )
                    .map((t) => ({ value: t.id, label: t.name })),
                ]}
                value={team}
                onChange={(e) => setTeam(e.target.value)}
              />
            </Field>
            <Field label="Discount Code">
              <input value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <RegistrationQuestions
              key={questionContext}
              programId={selectedProgram}
              personId={person.id}
              role={selectedRole}
              onChange={(value) =>
                setQuestions({ ...value, context: questionContext })
              }
            />
            {staff ? (
              <p>There is no fee for program staff registration.</p>
            ) : (
              <p>
                Base registration fee: {money(programs.find((p) => p.id === program)?.fee_cents ?? 0)}.
                Early or late pricing and discounts may change the final amount. Any balance will appear on a new invoice.
              </p>
            )}
            <div className="form-actions">
              <Button type="button" secondary onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={
                  busy ||
                  teams.loading ||
                  !!teams.error ||
                  (staff &&
                    (roleSettings.loading || !!roleSettings.error || !role)) ||
                  !questions.form_version ||
                  questions.context !== questionContext
                }
              >
                Register Member
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function MemberRegistrationTable({
  rows,
}: {
  rows: MemberRegistration[];
}) {
  const terminology = useTerminology();
  return (
    <DataTable
      rows={rows}
      columns={[
        {
          key: "name",
          label: "Name",
          render: (r) => (
            <Link to={"/members/" + r.person_id}>{memberName(r)}</Link>
          ),
        },
        {
          key: "season",
          label:
            terminology.data?.fields.find((f) => f.key === "season")?.label ||
            "Season",
        },
        {
          key: "program_name",
          label: "Program",
          render: (r) => (
            <Link to={"/programs/" + r.program_id}>{r.program_name}</Link>
          ),
        },
        { key: "team_name", label: "Team" },
        { key: "role", label: "Role" },
        {
          key: "created_at",
          label: "Registration Date",
          render: (r) => shortDate(r.created_at),
        },
        { key: "status", label: "Status" },
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
      ]}
    />
  );
}

export function HouseholdEditor() {
  const { id } = useParams(),
    navigate = useNavigate();
  return (
    <>
      <PageTitle title="Group Account Info" />
      <main className="content-page">
        {id ? (
          <LoadedHouseholdEditor
            id={id}
            done={(h) => navigate("/households/" + h.id)}
          />
        ) : (
          <HouseholdForm done={(h) => navigate("/households/" + h.id)} />
        )}
      </main>
    </>
  );
}
function LoadedHouseholdEditor({
  id,
  done,
}: {
  id: string;
  done: (h: Household) => void;
}) {
  const { data, error, loading } = useData<Household | null>(
    "/households/" + id,
    null,
  );
  return loading ? (
    <Loading />
  ) : data ? (
    <HouseholdForm initial={data} done={done} />
  ) : (
    <ErrorBox error={error} />
  );
}
function HouseholdForm({
  initial,
  done,
}: {
  initial?: Household;
  done: (h: Household) => void;
}) {
  const [name, setName] = useState(initial?.name ?? ""),
    [description, setDescription] = useState(initial?.description ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="narrow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          done(
            await api<Household>(
              "/households" + (initial ? "/" + initial.id : ""),
              {
                method: initial ? "PUT" : "POST",
                body: JSON.stringify({ name, description, type: "Family" }),
              },
            ),
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <Field label="Type">
        <Select options={["Family"]} />
      </Field>
      <Field label="Name" required>
        <input
          required
          maxLength={150}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <textarea
          maxLength={2000}
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="form-actions start">
        <Button disabled={busy}>{initial ? "Save Changes" : "Create"}</Button>
        <Link
          className="button secondary"
          to={initial ? "/households/" + initial.id : "/members"}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
export function HouseholdProfile() {
  const { id } = useParams(),
    {
      data: h,
      loading,
      error,
      reload,
    } = useData<Household | null>("/households/" + id, null),
    [adding, setAdding] = useState(false),
    [tab, setTab] = useState("Current"),
    [staffTab, setStaffTab] = useState("Current"),
    [removing, setRemoving] = useState<Person | null>(null),
    [actionError, setActionError] = useState("");
  const close = useCallback(() => setAdding(false), []),
    closeRemove = useCallback(() => setRemoving(null), []);
  if (loading) return <Loading />;
  if (!h) return <ErrorBox error={error} />;
  return (
    <>
      <PageTitle
        title={h.name}
        crumbs={[{ label: "Family Accounts", to: "/members" }]}
      />
      <main className="content-page">
        <ErrorBox error={error || actionError} />
        <div className="toolbar end">
          <Button onClick={() => setAdding(true)}>Add User</Button>
          <Link className="button" to={"/households/" + h.id + "/edit"}>
            Edit Family Account Details
          </Link>
        </div>
        {h.description && <p>{h.description}</p>}
        {["Supervisor", "Member"].map((role) => (
          <section key={role}>
            <h2>
              {role === "Supervisor"
                ? "Supervisors (Parents)"
                : "Members (Children)"}
            </h2>
            <DataTable
              rows={h.members.filter((p) => p.household_role === role)}
              columns={[
                {
                  key: "name",
                  label: "Name",
                  render: (p) => (
                    <Link to={"/members/" + p.id}>{memberName(p)}</Link>
                  ),
                },
                { key: "gender", label: "Gender" },
                {
                  key: "birthdate",
                  label: "Birthdate",
                  render: (p) => shortDate(p.birthdate),
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (p) => (
                    <button
                      className="square-action"
                      aria-label={"Remove " + memberName(p) + " from family"}
                      onClick={() => setRemoving(p)}
                    >
                      <X size={13} />
                    </button>
                  ),
                },
              ]}
            />
          </section>
        ))}
        <h2>Registrations</h2>
        <Tabs items={["Current", "Past"]} value={tab} onChange={setTab} />
        <MemberRegistrationTable
          rows={h.registrations.filter(
            (r) =>
              ["Free Agent", "Team Player"].includes(r.role) &&
              (r.program_status === "Completed") === (tab === "Past"),
          )}
        />
        <h2>Staff Assignments</h2>
        <Tabs
          items={["Current", "Past"]}
          value={staffTab}
          onChange={setStaffTab}
        />
        <MemberRegistrationTable
          rows={h.registrations.filter(
            (r) =>
              !["Free Agent", "Team Player"].includes(r.role) &&
              (r.program_status === "Completed") === (staffTab === "Past"),
          )}
        />
      </main>
      {adding && (
        <Modal title="Add Group Account Member" onClose={close}>
          <AddHouseholdMember
            household={h}
            done={() => {
              close();
              reload();
            }}
            cancel={close}
          />
        </Modal>
      )}
      {removing && (
        <Modal title="Remove Family Link" onClose={closeRemove}>
          <div className="modal-body">
            <p>
              Remove {memberName(removing)} from {h.name}? Their site membership
              and registrations will remain.
            </p>
            <div className="form-actions">
              <Button secondary onClick={closeRemove}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await api(
                      "/households/" + h.id + "/members/" + removing.id,
                      { method: "DELETE" },
                    );
                    closeRemove();
                    reload();
                  } catch (e) {
                    setActionError((e as Error).message);
                  }
                }}
              >
                Remove Link
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
function AddHouseholdMember({
  household,
  done,
  cancel,
}: {
  household: Household;
  done: () => void;
  cancel: () => void;
}) {
  const [role, setRole] = useState(""),
    [mode, setMode] = useState(""),
    [search, setSearch] = useState(""),
    [member, setMember] = useState(""),
    [error, setError] = useState("");
  const { data: people } = useData<Person[]>("/people", []),
    matches = people.filter(
      (p) =>
        !household.members.some((m) => m.id === p.id) &&
        `${memberName(p)} ${p.email} ${p.id}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  return (
    <div className="modal-body">
      <div className="inline wrap">
        {[
          ["Member", "Member (Child)"],
          ["Supervisor", "Supervisor (Parent)"],
        ].map(([value, label]) => (
          <label className="check" key={value}>
            <input
              type="radio"
              name="household-role"
              checked={role === value}
              onChange={() => setRole(value)}
            />
            {label}
          </label>
        ))}
      </div>
      {role && (
        <div className="inline">
          {["New User", "Existing User"].map((value) => (
            <label className="check" key={value}>
              <input
                type="radio"
                name="household-mode"
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {value}
            </label>
          ))}
        </div>
      )}
      {role && mode === "New User" ? (
        <MemberForm
          key={role}
          householdId={household.id}
          householdRole={role}
          done={done}
          cancel={cancel}
        />
      ) : role && mode === "Existing User" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/households/" + household.id + "/members", {
                method: "POST",
                body: JSON.stringify({ person_id: member, role }),
              });
              done();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <ErrorBox error={error} />
          <Field label="Find user by name/email/member ID">
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setMember("");
              }}
            />
          </Field>
          <Field label="Member">
            <Select
              required
              value={member}
              onChange={(e) => setMember(e.target.value)}
              options={[
                { value: "", label: "Choose a member" },
                ...matches.map((p) => ({
                  value: p.id,
                  label: memberName(p) + " — " + (p.email || p.id),
                })),
              ]}
            />
          </Field>
          {!matches.length && <Empty>No matching members.</Empty>}
          <div className="form-actions">
            <Button secondary type="button" onClick={cancel}>
              Cancel
            </Button>
            <Button disabled={!member}>
              <Plus size={14} />
              Add User
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
