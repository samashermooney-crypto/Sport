import { MemberCard } from "./member-card";
import { CaptainFields, type CaptainPermissions, type CaptainConfiguration } from "./team-permissions";
import type { StaffRoleSettings } from "./staff-roles";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  GripVertical,
  Lock,
  Pencil,
  Plus,
  Printer,
  Settings2,
  Trash2,
  Users,
} from "lucide-react";
import { api, csv, money, shortDate } from "./api";
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
  SearchBox,
  Select,
  Tabs,
  useData,
} from "./components";
import { ProgramNav } from "./programs";
import type { Activity, Person, Program, Registration, Team } from "./types";
type TeamRow = Team & {
  headline?: string;
  description?: string;
  notes?: string;
  locked: number;
  program_name?: string;
  staff?: {person_id:string;first_name:string;last_name:string;email:string;role:string}[];
  primary_staff?: {person_id:string;first_name:string;last_name:string;email:string;role:string} | null;
  parent_id?: string | null;
  start_date?: string;
  pending: number;
  registration_status: "Complete" | "Incomplete";
  players_male: number;
  players_female: number;
  players_nonbinary: number;
  players_unknown: number;
  created_at: string;
};
type Staff = Person & {
  is_primary?: boolean;
  person_id: string;
  role: string;
  legacy_registration?: boolean;
};
type Profile = TeamRow & {
  org_id: string;
  registration_state: {
    status: "Complete" | "Incomplete";
    reasons: string[];
  };
  program: Program;
  roster: (Registration & { parent_contacts?: Person[] })[];
  staff: Staff[];
  events: Activity[];
  invoiced: number;
  paid: number;
};
type RosterPreferences = {
  version?: number;
  website?: {audience: string; parent_contacts?: boolean; staff_fields?: {key:string;visibility:string}[]; fields: {key: string; visibility: string}[]};
  fields: string[];
  parent_contacts: boolean;
  allow_staff_print: boolean;
  foreground: string;
  background: string;
};
const name = (p: { first_name: string; last_name: string }) =>
  p.first_name + " " + p.last_name;
export function Teams() {
  const { id } = useParams(),
    programs = useData<Program[]>("/programs", []),
    teams = useData<TeamRow[]>("/teams" + (id ? "?program_id=" + id : ""), []),
    [search, setSearch] = useState(""),
    [staffSearch, setStaffSearch] = useState(""),
    [program, setProgram] = useState(""),
    [division, setDivision] = useState(""),
    [registrationStatus, setRegistrationStatus] = useState(""),
    [filters, setFilters] = useState(false),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [adding, setAdding] = useState(false),
    [edit, setEdit] = useState<TeamRow | null>(null),
    [copy, setCopy] = useState<TeamRow | null>(null),
    [printTeam, setPrintTeam] = useState<string | null>(null),
    [printAll, setPrintAll] = useState<string[] | null>(null),
    [cardTeam, setCardTeam] = useState<string | null>(null),
    [remove, setRemove] = useState<TeamRow | null>(null),
    [error, setError] = useState(""),
    navigate = useNavigate();
  const current = programs.data.find((p) => p.id === id),
    rows = teams.data.filter(
      (t) =>
        t.name.toLowerCase().includes(search.toLowerCase()) &&
        (!staffSearch || (t.staff || []).some(p => `${p.first_name} ${p.last_name}`.toLowerCase().includes(staffSearch.toLowerCase()))) &&
        (!program || t.program_id === program || (!id && t.parent_id === program)) &&
        (!division || t.division === division) &&
        (!registrationStatus || t.registration_status === registrationStatus),
    );
  return (
    <>
      <PageTitle title={current ? current.name + " › Teams" : "Teams"} />
      {id && <ProgramNav id={id} active="Teams" />}
      <main className="content-page teams-page">
        <ErrorBox error={error || teams.error} />
        <div className="page-tools">
          <div className="inline">
            <Button secondary onClick={() => setFilters(!filters)}>
              <Settings2 size={14} /> {filters ? "Hide" : "Show"} filters
            </Button>
            <Button
              secondary
              disabled={teams.loading || !!teams.error || !rows.length}
              onClick={() => setPrintAll(rows.map((t) => t.id))}
            >
              Print All Team Rosters
            </Button>
            <Button
              secondary
              disabled={!rows.some((t) => selected.has(t.id))}
              onClick={() => {
                const query = new URLSearchParams();
                rows
                  .filter((t) => selected.has(t.id))
                  .forEach((t) => query.append("team", t.id));
                navigate("/messaging/compose?" + query.toString());
              }}
            >
              Message Teams ({rows.filter((t) => selected.has(t.id)).length})
            </Button>
            <ExportButton
              onClick={() =>
                csv(
                  "teams",
                  ["Team", "Program", ...(!id ? ["Sub-program", "Primary staff/Captain", "Primary contact email"] : []), "Division", "Players", "Pending", "Registration status", "Registered"],
                  rows.map((t) => [
                    t.name,
                    !id && t.parent_id ? programs.data.find(p=>p.id===t.parent_id)?.name || "" : t.program_name,
                    ...(!id ? [t.parent_id ? t.program_name || "" : "", t.primary_staff ? name(t.primary_staff) : "", t.primary_staff?.email || ""] : []),
                    t.division,
                    t.players,
                    t.pending,
                    t.registration_status,
                    t.created_at,
                  ]),
                )
              }
            />
          </div>
          <div className="inline">
            {id && (
              <>
                <Link
                  className="button secondary"
                  to={"/programs/" + id + "/roster-settings"}
                >
                  Roster Settings
                </Link>
                <Link
                  className="button secondary"
                  to={"/programs/" + id + "/team-builder"}
                >
                  Launch team builder
                </Link>
              </>
            )}
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} />
              Add a Team
            </Button>
          </div>
        </div>
        {filters && (
          <div className="filter-bar">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search team name"
            />
            {!id && (
              <Select
                aria-label="Program"
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                options={[
                  { value: "", label: "All programs" },
                  ...programs.data
                    .map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            )}
            {!id && <SearchBox value={staffSearch} onChange={setStaffSearch} placeholder="Search staff/captain name"/>}
            <Select
              aria-label="Division"
              value={division}
              onChange={(e) => setDivision(e.target.value)}
              options={[
                { value: "", label: "All divisions" },
                ...[
                  ...new Set(teams.data.map((t) => t.division).filter(Boolean)),
                ].map((d) => ({ value: d, label: d })),
              ]}
            />
            <Select
              aria-label="Registration status"
              value={registrationStatus}
              onChange={(e) => setRegistrationStatus(e.target.value)}
              options={[
                { value: "", label: "Any Reg Status" },
                "Incomplete",
                "Complete",
              ]}
            />
            <Button
              secondary
              onClick={() => {
                setSearch("");
                setStaffSearch("");
                setProgram("");
                setDivision("");
                setRegistrationStatus("");
              }}
            >
              Clear
            </Button>
          </div>
        )}
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={!!rows.length && rows.every((t) => selected.has(t.id))}
            onChange={(e) =>
              setSelected(
                e.target.checked ? new Set(rows.map((t) => t.id)) : new Set(),
              )
            }
          />
          Select all matching teams
        </label>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={rows.length > 0 && rows.every((t) => expanded.has(t.id))}
            onChange={(e) =>
              setExpanded(
                e.target.checked ? new Set(rows.map((t) => t.id)) : new Set(),
              )
            }
          />
          Show all team details
        </label>
        <p className="teams-scroll-hint">
          Scroll the table horizontally to see all team details and actions.
        </p>
        <DataTable
          pagination
          rows={rows}
          details={(t) =>
            expanded.has(t.id) ? (
              <section aria-label={`${t.name} details`}>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      next.delete(t.id);
                      return next;
                    })
                  }
                >
                  Close
                </button>
                <p>
                  <button type="button" onClick={() => setPrintTeam(t.id)}>
                    Print Team Roster
                  </button>
                </p>
                <p>
                  <button type="button" onClick={() => setCardTeam(t.id)}>
                    Generate Member Cards
                  </button>
                </p>
                <h4>Notes:</h4>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {t.notes || "You haven't entered any notes for this team..."}
                </p>
                <button type="button" onClick={() => setEdit(t)}>
                  Edit notes
                </button>
              </section>
            ) : null
          }
          columns={[
            {
              key: "selected",
              label: "Select",
              render: (t) => (
                <input
                  type="checkbox"
                  aria-label={`Select ${t.name}`}
                  checked={selected.has(t.id)}
                  onChange={(e) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(t.id);
                      else next.delete(t.id);
                      return next;
                    })
                  }
                />
              ),
            },
            {
              key: "name",
              className: "team-name-cell",
              label: "Team Name",
              sort: (t) => t.name,
              render: (t) => (
                <>
                  <Link to={"/teams/" + t.id}>
                    <strong>{t.name}</strong>
                    {t.locked ? <Lock size={12} /> : null}
                  </Link>
                  <button
                    type="button"
                    className="team-details-toggle"
                    aria-label={`Details for ${t.name}`}
                    aria-expanded={expanded.has(t.id)}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(t.id)) next.delete(t.id);
                        else next.add(t.id);
                        return next;
                      })
                    }
                  >
                    {expanded.has(t.id) ? "Hide details" : "Show details"}
                  </button>
                </>
              ),
            },
            {
              key: "program",
              className: "team-program-cell",
              label: "Program",
              sort: !id ? (t) => (t.parent_id ? programs.data.find(p => p.id === t.parent_id)?.name : t.program_name) || "" : undefined,
              render: (t) => (
                <>
                  <Link to={"/programs/" + (!id && t.parent_id ? t.parent_id : t.program_id)}>
                    {!id && t.parent_id ? programs.data.find(p => p.id === t.parent_id)?.name || "Parent program" : t.program_name || programs.data.find((p) => p.id === t.program_id)?.name}
                  </Link>
                  {!id && <small className="cell-sub">{programs.data.find(p => p.id === (t.parent_id || t.program_id))?.start_date ? `Starts ${shortDate(programs.data.find(p => p.id === (t.parent_id || t.program_id))?.start_date || "")}` : ""}</small>}
                </>
              ),
            },
            ...(!id ? [{
              key: "sub_program", label: "Sub-program", className: "team-program-cell",
              render: (t: TeamRow) => t.parent_id ? <><Link to={"/programs/" + t.program_id}>{t.program_name}</Link>{t.start_date && <small className="cell-sub">Starts {shortDate(t.start_date)}</small>}</> : "—",
            }, {
              key: "staff", label: "Primary staff/Captain", className: "team-program-cell",
              sort: (t: TeamRow) => t.primary_staff ? name(t.primary_staff) : "",
              render: (t: TeamRow) => t.primary_staff ? <div><Link to={"/members/" + t.primary_staff.person_id}>{name(t.primary_staff)}</Link><small className="cell-sub">{t.primary_staff.email}</small></div> : "—",
            }] : []),
            {
              key: "players",
              className: "team-players-cell",
              label: "Players",
              sort: (t) => t.players,
              render: (t) => (
                <>
                  <strong>{t.players}</strong>
                  {t.players > 0 && (
                    <small className="team-player-breakdown">
                      {t.players_male} Males · {t.players_female} Females
                      {t.players_nonbinary > 0
                        ? ` · ${t.players_nonbinary} Non-binary`
                        : ""}
                      <br />
                      {t.players_unknown} Unknown
                    </small>
                  )}
                </>
              ),
            },
            { key: "pending", label: "Pending" },
            { key: "registration_status", label: "Registration Status" },
            { key: "division", label: "Division" },
            {
              key: "created_at",
              label: "Registered",
              sort: (t) => t.created_at,
              render: (t) => shortDate(t.created_at),
            },
            {
              key: "actions",
              className: "team-actions-cell",
              label: "Actions",
              render: (t) => (
                <div className="row-actions">
                  <Link title="View roster" to={"/teams/" + t.id}>
                    <Users size={14} />
                  </Link>
                  <button title="Edit team" onClick={() => setEdit(t)}>
                    <Pencil size={14} />
                  </button>
                  <button title="Copy team" onClick={() => setCopy(t)}>
                    <Copy size={14} />
                  </button>
                  <button title="Remove team" onClick={() => setRemove(t)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ),
            },
          ]}
        />
      </main>
      {(adding || edit) && (
        <Modal
          title={edit ? "Edit team" : "Add Team"}
          onClose={() => {
            setAdding(false);
            setEdit(null);
          }}
        >
          <TeamForm
            programs={programs.data}
            programId={id || ""}
            initial={edit || undefined}
            afterSaveAnother={teams.reload}
            done={() => {
              setAdding(false);
              setEdit(null);
              teams.reload();
            }}
            cancel={() => {
              setAdding(false);
              setEdit(null);
            }}
          />
        </Modal>
      )}
      {copy && (
        <Modal title="Copy team" onClose={() => setCopy(null)}>
          <CopyTeamForm
            team={copy}
            programs={programs.data}
            cancel={() => setCopy(null)}
            done={(team) => {
              setCopy(null);
              navigate("/teams/" + team.id);
            }}
          />
        </Modal>
      )}
      {cardTeam && (
        <Modal title="Team Member Cards" wide onClose={() => setCardTeam(null)}>
          <TeamMemberCards key={cardTeam} teamId={cardTeam} />
        </Modal>
      )}
      {printAll && (
        <Modal title="All Team Rosters" wide onClose={() => setPrintAll(null)}>
          <AllRosterPreview teamIds={printAll} />
        </Modal>
      )}
      {printTeam && (
        <Modal title="Team Roster" wide onClose={() => setPrintTeam(null)}>
          <TeamRosterPreview key={printTeam} teamId={printTeam} />
        </Modal>
      )}
      {remove && (
        <Modal title="Remove team" onClose={() => setRemove(null)}>
          <div className="modal-body">
            <p>
              Remove {remove.name}? Teams with registrations, staff, or
              scheduled activities must have those associations removed first.
            </p>
            <ErrorBox error={error} />
            <Button
              onClick={async () => {
                try {
                  await api("/teams/" + remove.id, { method: "DELETE" });
                  setRemove(null);
                  teams.reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Remove Team
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function CopyTeamForm({
  team,
  programs,
  cancel,
  done,
}: {
  team: TeamRow;
  programs: Program[];
  cancel: () => void;
  done: (team: Team) => void;
}) {
  const [name, setName] = useState(team.name + " Copy"),
    [programId, setProgramId] = useState(team.program_id),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          done(
            await api<Team>(`/teams/${team.id}/copy`, {
              method: "POST",
              body: JSON.stringify({ name, program_id: programId }),
            }),
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        The copied team inherits the destination program's registration
        settings.
      </p>
      <ErrorBox error={error} />
      <Field label="Team name" required>
        <input
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Destination program" required>
        <Select
          required
          value={programId}
          onChange={(e) => setProgramId(e.target.value)}
          options={programs
            .filter((p) => !p.grouped)
            .map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      <div className="form-actions">
        <Button secondary type="button" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button disabled={busy}>{busy ? "Copying…" : "Copy team"}</Button>
      </div>
    </form>
  );
}
function TeamForm({
  programs,
  programId,
  initial,
  done,
  cancel,
  afterSaveAnother,
}: {
  programs: Program[];
  programId: string;
  initial?: TeamRow;
  afterSaveAnother?: () => void;
  done: (team: TeamRow) => void;
  cancel: () => void;
}) {
  const [form, setForm] = useState({
      program_id: initial?.program_id || programId,
      name: initial?.name || "",
      division: initial?.division || "",
      headline: initial?.headline || "",
      description: initial?.description || "",
      notes: initial?.notes || "",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState("");
  const [captain, setCaptain] = useState<{
    programId: string;
    version?: number;
    detached: boolean;
    permissions: CaptainPermissions;
    inherited: CaptainPermissions;
  } | null>(null);
  useEffect(() => {
    if (!form.program_id) return;
    let active = true;
    setCaptain(null);
    const request = initial
      ? api<{
          version: number;
          detached: boolean;
          permissions: CaptainPermissions;
          inherited: CaptainPermissions;
        }>(`/teams/${initial.id}/captain-permissions`)
      : api<{ captain_permissions: CaptainPermissions }>(
          `/programs/${form.program_id}/options`,
        ).then((rules) => ({
          detached: false,
          permissions: rules.captain_permissions,
          inherited: rules.captain_permissions,
        }));
    request
      .then((value) => {
        if (active) setCaptain({ ...value, programId: form.program_id });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [form.program_id, initial]);
  const captainReady = captain?.programId === form.program_id;
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !captainReady) return;
        const addAnother =
          (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
          "another";
        setBusy(true);
        setSaved("");
        setError("");
        try {
          const team = await api<TeamRow>(
            "/teams" + (initial ? "/" + initial.id : ""),
            {
              method: initial ? "PUT" : "POST",
              body: JSON.stringify({
                ...form,
                ...(captain
                  ? {
                      captain_settings: {
                        ...(initial ? { version: captain.version } : {}),
                        detached: captain.detached,
                        permissions: captain.permissions,
                      },
                    }
                  : {}),
              }),
            },
          );
          if (addAnother && !initial) {
            setSaved(`${team.name} saved. Add the next team below.`);
            setForm((current) => ({
              ...current,
              name: "",
              headline: "",
              description: "",
              notes: "",
            }));
            setCaptain((current) =>
              current
                ? {
                    ...current,
                    detached: false,
                    permissions: current.inherited,
                  }
                : null,
            );
            afterSaveAnother?.();
          } else done(team);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      {saved && <p role="status">{saved}</p>}
      <Field label="Program" required>
        <Select
          required
          disabled={!!initial}
          value={form.program_id}
          onChange={(e) => setForm({ ...form, program_id: e.target.value })}
          options={[
            { value: "", label: "Select program" },
            ...programs
              .filter((p) => !p.grouped)
              .map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </Field>
      <Field label="Team Name" required>
        <input
          required
          maxLength={80}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Field>
      <Field label="Division">
        <input
          maxLength={100}
          value={form.division}
          onChange={(e) => setForm({ ...form, division: e.target.value })}
        />
      </Field>
      <h3>Price Structure</h3>
      <p>Per-player registration fees and invoices.</p>
      <Field label="Team Headline">
        <input
          maxLength={200}
          value={form.headline}
          onChange={(e) => setForm({ ...form, headline: e.target.value })}
        />
      </Field>
      <Field label="Team Description">
        <textarea
          rows={4}
          maxLength={500}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <Field label="Notes">
        <textarea
          rows={3}
          maxLength={250}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>
      <p>{250 - form.notes.length} characters left for notes.</p>
      {captainReady && captain && (
        <section>
          <h3>Captain Settings</h3>
          <CaptainFields
            value={captain.permissions}
            disabled={!captain.detached || busy}
            change={(permissions) => setCaptain({ ...captain, permissions })}
          />
          <label className="checkbox-line">
            <input
              type="checkbox"
              disabled={busy}
              checked={captain.detached}
              onChange={(e) =>
                setCaptain({
                  ...captain,
                  detached: e.target.checked,
                  permissions: e.target.checked
                    ? captain.permissions
                    : captain.inherited,
                })
              }
            />
            Detach Captain Settings, so that changes on the program level don't
            affect this team anymore
          </label>
        </section>
      )}
      <div className="form-actions">
        <Button secondary type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button disabled={busy || !captainReady}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {!initial && (
          <Button
            secondary
            name="save-action"
            value="another"
            disabled={busy || !captainReady}
          >
            Save &amp; add another team
          </Button>
        )}
      </div>
    </form>
  );
}
export function TeamProfile() {
  const roleSettings = useData<StaffRoleSettings>("/settings/staff-roles", {
    version: 1,
    roles: [],
  });
  const { teamId } = useParams(),
    data = useData<Profile | null>("/teams/" + teamId, null),
    captain = useData<CaptainConfiguration | null>(
      `/teams/${teamId}/captain-permissions`,
      null,
    ),
    programs = useData<Program[]>("/programs", []),
    people = useData<Person[]>("/people", []),
    [tab, setTab] = useState("Confirmed Roster"),
    [edit, setEdit] = useState(false),
    [staffModal, setStaffModal] = useState(false),
    [primaryBusy, setPrimaryBusy] = useState(false),
    [person, setPerson] = useState(""),
    [role, setRole] = useState("Coach"),
    [error, setError] = useState(""),
    [lock, setLock] = useState(false),
    [print, setPrint] = useState(false),
    [staffRemove, setStaffRemove] = useState<Staff | null>(null);
  useEffect(() => {
    if (
      !roleSettings.loading &&
      !roleSettings.data.roles.some((r) => r.name === role)
    )
      setRole(roleSettings.data.roles[0]?.name || "");
  }, [roleSettings.data, roleSettings.loading, role]);
  if (data.loading) return <Loading />;
  if (!data.data) return <ErrorBox error={data.error} />;
  const t = data.data;
  return (
    <>
      <PageTitle
        title={t.name}
        crumbs={[
          { label: t.program.name, to: "/programs/" + t.program_id },
          { label: "Teams", to: "/programs/" + t.program_id + "/teams" },
        ]}
      />
      <ProgramNav id={t.program_id} active="Teams" />
      <main className="content-page team-profile-page">
        <ErrorBox error={error || data.error} />
        <div className="team-overview">
          <div>
            <span className="team-avatar">
              {t.name.slice(0, 2).toUpperCase()}
            </span>
            <h2>{t.name}</h2>
            <p>{t.headline}</p>
            <Button secondary onClick={() => setEdit(true)}>
              Edit Team Details
            </Button>
          </div>
          <div>
            <p>
              <strong>Registration status:</strong>{" "}
              {t.registration_state.status}
            </p>
            {t.registration_state.reasons.length > 0 && (
              <ul className="team-completion-reasons">
                {t.registration_state.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <p>
              <strong>Roster:</strong> {t.locked ? "Locked" : "Unlocked"}
            </p>
            <p>
              <strong>Players:</strong>{" "}
              {t.roster.filter((r) => r.status === "Confirmed").length}{" "}
              confirmed ·{" "}
              {t.roster.filter((r) => r.status === "Pending").length} pending
            </p>
            <p>
              <strong>Division:</strong> {t.division || "Not assigned"}
            </p>
            <section className="team-captain-summary" aria-label="Captain settings">
              <h3>Captain Settings</h3>
              {captain.loading ? (
                <Loading />
              ) : captain.error ? (
                <ErrorBox error={captain.error} />
              ) : captain.data && (
                <>
                  <ul>
                    <li>Captain can{captain.data.permissions.edit_name ? "" : "not"} edit team name.</li>
                    <li>Administrators manage player enrollment and roster changes.</li>
                  </ul>
                  <small>{captain.data.detached ? "Custom team settings" : "Inherited from program settings"}</small>
                </>
              )}
            </section>
            <p>
              <strong>Price Structure:</strong> Per player
            </p>
            <p>{t.description}</p>
          </div>
          <div className="team-finance">
            <div>
              <span>Paid</span>
              <strong>{money(t.paid)}</strong>
            </div>
            <div>
              <span>Invoiced</span>
              <strong>{money(t.invoiced)}</strong>
            </div>
            <div>
              <span>Outstanding</span>
              <strong>{money(t.invoiced - t.paid)}</strong>
            </div>
          </div>
        </div>
        <Tabs
          items={["Confirmed Roster", "Staff", "Schedule"]}
          value={tab}
          onChange={setTab}
        />
        {tab === "Confirmed Roster" && (
          <>
            <div className="page-tools">
              <div className="inline">
                <Link
                  className="button secondary"
                  to={"/programs/" + t.program_id + "/roster-settings"}
                >
                  Roster Settings
                </Link>
                <Link className="button secondary" to={`/site/${t.org_id}/teams/${t.id}`}>View Website Roster</Link>
                <Button secondary onClick={() => setPrint(true)}>
                  <Printer size={14} />
                  Print Roster
                </Button>
                <Button secondary onClick={() => setLock(true)}>
                  <Lock size={14} />
                  {t.locked ? "Unlock" : "Lock"} Roster
                </Button>
              </div>
              <Link
                className="button"
                to={"/programs/" + t.program_id + "/team-builder"}
              >
                Launch team builder
              </Link>
            </div>
            <p className="calendar-scroll-hint">
              Scroll the roster horizontally to see registration, waiver, and payment details.
            </p>
            <DataTable
              rows={t.roster}
              columns={[
                {
                  key: "name",
                  label: "Player Name",
                  render: (r) => (
                    <Link to={"/members/" + r.person_id}>{name(r)}</Link>
                  ),
                },
                { key: "gender", label: "Gender" },
                {
                  key: "birthdate",
                  label: "Birth Date",
                  render: (r) => shortDate(r.birthdate),
                },
                { key: "role", label: "Role" },
                { key: "status", label: "Status" },
                {
                  key: "waiver",
                  label: "Waiver",
                  render: (r) =>
                    r.waiver_accepted_at ? "Accepted" : "Not accepted",
                },
                {
                  key: "invoice",
                  label: "Payment",
                  render: (r) =>
                    r.invoice_id ? (
                      <Link to={"/invoices/" + r.invoice_id}>
                        {money(r.total_cents - r.paid_cents)} due
                      </Link>
                    ) : (
                      "Not invoiced"
                    ),
                },
                {
                  key: "created_at",
                  label: "Registered",
                  render: (r) => shortDate(r.created_at),
                },
              ]}
            />
          </>
        )}
        {tab === "Staff" && (
          <>
            <div className="page-tools">
              <Button onClick={() => setStaffModal(true)}>
                Add Existing Staff
              </Button>
            </div>
            <DataTable
              rows={t.staff}
              columns={[
                { key: "role", label: "Role" },
                {
                  key: "name",
                  label: "Staff Name",
                  render: (s) => (
                    <Link to={"/members/" + s.person_id}>{name(s)}</Link>
                  ),
                },
                { key: "email", label: "Email" },
                { key: "phone", label: "Phone" },
                {
                  key: "is_primary", label: "Primary staff",
                  render: (s) => s.is_primary ? "Primary" : <Button secondary disabled={primaryBusy} onClick={async () => {
                    setPrimaryBusy(true);
                    setError("");
                    try {
                      await api("/teams/" + t.id + "/primary-staff", {method: "POST", body: JSON.stringify({person_id: s.person_id})});
                      data.reload();
                    } catch (e) { setError((e as Error).message); }
                    finally { setPrimaryBusy(false); }
                  }}>Make primary</Button>,
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (s) =>
                    s.legacy_registration ? (
                      <span>Program registration</span>
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => setStaffRemove(s)}
                      >
                        Remove
                      </button>
                    ),
                },
              ]}
            />
          </>
        )}
        {tab === "Schedule" && (
          <>
            <div className="page-tools">
              <Link
                className="button"
                to={"/programs/" + t.program_id + "/schedule"}
              >
                Manage Schedule
              </Link>
            </div>
            <DataTable
              rows={t.events}
              columns={[
                { key: "title", label: "Activity" },
                {
                  key: "start_at",
                  label: "Date",
                  render: (e) => new Date(e.start_at).toLocaleString(),
                },
                { key: "state", label: "Status" },
                {
                  key: "score",
                  label: "Score",
                  render: (e) =>
                    e.home_score === null
                      ? "—"
                      : `${e.home_score} – ${e.away_score}`,
                },
              ]}
            />
          </>
        )}
      </main>
      {edit && (
        <Modal title="Edit Team Details" onClose={() => setEdit(false)}>
          <TeamForm
            programs={programs.data}
            programId={t.program_id}
            initial={t}
            done={() => {
              setEdit(false);
              data.reload();
              captain.reload();
            }}
            cancel={() => setEdit(false)}
          />
        </Modal>
      )}
      {staffModal && (
        <Modal title="Add Existing Staff" onClose={() => setStaffModal(false)}>
          <form
            className="modal-body"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/teams/" + t.id + "/staff", {
                  method: "POST",
                  body: JSON.stringify({ person_id: person, role }),
                });
                setStaffModal(false);
                data.reload();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <ErrorBox error={error} />
            <Field label="Staff member" required>
              <Select
                required
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                options={[
                  { value: "", label: "Select a member" },
                  ...people.data
                    .filter((p) => !t.staff.some((s) => s.person_id === p.id))
                    .map((p) => ({
                      value: p.id,
                      label: name(p) + (p.email ? " — " + p.email : ""),
                    })),
                ]}
              />
            </Field>
            <Field label="Role">
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                options={roleSettings.data.roles.map((r) => r.name)}
              />
            </Field>
            <div className="form-actions">
              <Button
                secondary
                type="button"
                onClick={() => setStaffModal(false)}
              >
                Cancel
              </Button>
              <Button>Add Staff</Button>
            </div>
          </form>
        </Modal>
      )}
      {lock && (
        <Modal
          title={t.locked ? "Unlock Roster" : "Lock Roster"}
          onClose={() => setLock(false)}
        >
          <div className="modal-body">
            <p>
              {t.locked
                ? "Players can be assigned or moved after unlocking."
                : "A locked roster prevents adding or moving players."}
            </p>
            <Button
              onClick={async () => {
                try {
                  await api("/teams/" + t.id + "/lock", {
                    method: "POST",
                    body: JSON.stringify({ locked: !t.locked }),
                  });
                  setLock(false);
                  data.reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Confirm
            </Button>
          </div>
        </Modal>
      )}
      {staffRemove && (
        <Modal
          title="Remove Staff Assignment"
          onClose={() => setStaffRemove(null)}
        >
          <div className="modal-body">
            <p>Remove {name(staffRemove)} from this team?</p>
            <Button
              onClick={async () => {
                try {
                  await api("/teams/" + t.id + "/staff/" + staffRemove.id, {
                    method: "DELETE",
                  });
                  setStaffRemove(null);
                  data.reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Remove Staff
            </Button>
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
      {print && (
        <Modal title="Team Roster" wide onClose={() => setPrint(false)}>
          <RosterPrint team={t} />
        </Modal>
      )}
    </>
  );
}
function TeamMemberCards({ teamId }: { teamId: string }) {
  const [result, setResult] = useState<{
      name: string;
      organization: string;
      people: Person[];
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function load() {
      const [team, session] = await Promise.all([
        api<Profile>(`/teams/${teamId}`),
        api<{ organization: { name: string } }>("/session"),
      ]);
      const ids = [...new Set(team.roster.map((r) => r.person_id))],
        people: Person[] = [];
      for (let i = 0; i < ids.length && active; i += 8)
        people.push(
          ...(await Promise.all(
            ids.slice(i, i + 8).map((id) => api<Person>(`/people/${id}`)),
          )),
        );
      if (active)
        setResult({
          name: team.name,
          organization: session.organization.name,
          people: people.filter((p) => !p.archived_at),
        });
    }
    load().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [teamId]);
  if (error) return <ErrorBox error={error} />;
  if (!result) return <Loading />;
  return (
    <div className="modal-body">
      <h3>{result.name}</h3>
      {result.people.length ? (
        <>
          <p>{result.people.length} player member cards</p>
          <div className="team-member-cards">
            {result.people.map((person) => (
              <MemberCard
                key={person.id}
                person={person}
                organizationName={result.organization}
              />
            ))}
          </div>
          <div className="form-actions">
            <Button onClick={() => window.print()}>Print Cards</Button>
          </div>
        </>
      ) : (
        <Empty>No players on this team.</Empty>
      )}
    </div>
  );
}
function AllRosterPreview({ teamIds }: { teamIds: string[] }) {
  const [loaded, setLoaded] = useState<
      { team: Profile; preferences: RosterPreferences }[] | null
    >(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function load() {
      const profiles: Profile[] = [];
      for (let i = 0; i < teamIds.length && active; i += 8) {
        profiles.push(
          ...(await Promise.all(
            teamIds.slice(i, i + 8).map((id) => api<Profile>(`/teams/${id}`)),
          )),
        );
      }
      if (!active) return;
      const preferences = new Map<string, RosterPreferences>();
      for (const id of new Set(profiles.map((t) => t.program_id))) {
        if (!active) return;
        preferences.set(
          id,
          await api<RosterPreferences>(`/programs/${id}/roster-settings`),
        );
      }
      if (active)
        setLoaded(
          profiles.map((team) => ({
            team,
            preferences: preferences.get(team.program_id)!,
          })),
        );
    }
    load().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [teamIds]);
  if (error) return <ErrorBox error={error} />;
  if (!loaded) return <Loading />;
  return (
    <>
      <p className="modal-body">
        {loaded.length} team rosters matching the current filters.
      </p>
      <div className="all-rosters">
        {loaded.map(({ team, preferences }) => (
          <RosterPrintContent
            key={team.id}
            team={team}
            preferences={preferences}
            showPrint={false}
          />
        ))}
      </div>
      <div className="modal-body form-actions">
        <Button disabled={!loaded.length} onClick={() => window.print()}>
          <Printer size={14} />
          Print
        </Button>
      </div>
    </>
  );
}
function TeamRosterPreview({ teamId }: { teamId: string }) {
  const team = useData<Profile | null>(`/teams/${teamId}`, null);
  if (team.loading) return <Loading />;
  if (team.error || !team.data)
    return <ErrorBox error={team.error || "Team not found"} />;
  return <RosterPrint team={team.data} />;
}
function RosterPrint({ team }: { team: Profile }) {
  const settings = useData<RosterPreferences>(
    "/programs/" + team.program_id + "/roster-settings",
    {
      fields: ["name", "gender", "birthdate", "email"],
      parent_contacts: true,
      allow_staff_print: true,
      foreground: "#ffffff",
      background: "#206334",
    },
  );
  if (settings.loading) return <Loading />;
  if (settings.error) return <ErrorBox error={settings.error} />;
  return <RosterPrintContent team={team} preferences={settings.data} />;
}
function RosterPrintContent({
  team,
  preferences,
  showPrint = true,
}: {
  team: Profile;
  preferences: RosterPreferences;
  showPrint?: boolean;
}) {
  const labels: Record<string, string> = {
    name: "Player Name",
    gender: "Gender",
    birthdate: "Birth Date",
    email: "Email",
    phone: "Mobile",
    address: "Address",
    member_id: "Member ID",
    invoice: "Invoice",
    balance: "Balance",
  };
  return (
    <div className="modal-body">
      <div className="print-roster">
        <header
          style={{
            background: preferences.background,
            color: preferences.foreground,
          }}
        >
          <h1>{team.name}</h1>
          <p>{team.program.name}</p>
        </header>
        <h3>Staff</h3>
        <p>
          {team.staff.map((s) => name(s) + " (" + s.role + ")").join(" · ") ||
            "No staff assigned"}
        </p>
        <table>
          <thead>
            <tr>
              {preferences.fields.map((f) => (
                <th key={f}>{labels[f]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {team.roster.map((r) => (
              <tr key={r.id}>
                {preferences.fields.map((f) => (
                  <td key={f}>
                    {f === "name"
                      ? name(r)
                      : f === "birthdate"
                        ? shortDate(r.birthdate)
                        : f === "member_id"
                          ? r.person_id
                          : f === "balance"
                            ? money((r.total_cents || 0) - (r.paid_cents || 0))
                            : f === "invoice"
                              ? money(r.total_cents || 0)
                              : preferences.parent_contacts &&
                                  ["email", "phone", "address"].includes(f) &&
                                  r.parent_contacts?.length
                                ? r.parent_contacts
                                    .map((p) =>
                                      String(
                                        (
                                          p as unknown as Record<
                                            string,
                                            unknown
                                          >
                                        )[f] || "",
                                      ),
                                    )
                                    .filter(Boolean)
                                    .join("; ") || "—"
                                : String(
                                    (r as unknown as Record<string, unknown>)[
                                      f
                                    ] || "—",
                                  )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showPrint && (
        <div className="form-actions">
          <Button onClick={() => window.print()}>
            <Printer size={14} />
            Print
          </Button>
        </div>
      )}
    </div>
  );
}
export function RosterSettings() {
  const { id } = useParams(),
    data = useData<RosterPreferences | null>(
      "/programs/" + id + "/roster-settings",
      null,
    );
  if (data.loading) return <Loading />;
  return data.data ? (
    <RosterSettingsForm key={id} initial={data.data} programId={id!} />
  ) : (
    <ErrorBox error={data.error} />
  );
}
function RosterSettingsForm({
  initial,
  programId,
}: {
  initial: RosterPreferences;
  programId: string;
}) {
  const [form, setForm] = useState(initial),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <>
      <PageTitle title="Roster Settings" />
      <ProgramNav id={programId} active="Teams" />
      <main className="content-page">
        <form
          className="roster-settings"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            setSaving(true);
            setError("");
            try {
              const result = await api<RosterPreferences>("/programs/" + programId + "/roster-settings", {
                method: "PUT",
                body: JSON.stringify(form),
              });
              setForm(current => ({...current,version:result.version}));
              setSaved(JSON.stringify({...form,version:result.version}));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <ErrorBox error={error} />
          <h2>Website Roster</h2>
          <Check checked={!!form.website} onChange={e => setForm({...form, website: e.target.checked ? {audience: "Team Members", fields: []} : undefined})}>Enable website roster</Check>
          {form.website && <>
            <Check checked={!!form.website.parent_contacts} onChange={e=>setForm({...form,website:{...form.website!,parent_contacts:e.target.checked}})}>Use parent contact details instead of child contact details</Check>
            <Field label="Who can view the roster?">
              <Select value={form.website.audience} options={["Public", "Logged in users", "Team Members", "Staff Only", "Primary Staff Only"]} onChange={e => setForm({...form, website: {...form.website!, audience:e.target.value}})}/>
            </Field>
            <div className="table-scroll"><table><thead><tr><th>Field</th><th>Include in website roster</th><th>Visibility</th></tr></thead><tbody>
              {[["name","Name"],["gender","Gender"],["birthdate","Birth Date"],["email","Email"],["phone","Mobile"],["address","Address"],["member_id","Member ID"],["invoice","Invoiced"],["balance","Balance"],["due_date","Payment deadline"]].map(([key,label]) => {
                const field = form.website!.fields.find(f => f.key === key);
                return <tr key={key}><td>{label}</td><td><Check aria-label={`Include ${label} in website roster`} checked={!!field} onChange={e => setForm({...form,website:{...form.website!,fields:e.target.checked ? [...form.website!.fields,{key,visibility:"Team Members"}] : form.website!.fields.filter(f=>f.key!==key)}})}>{label}</Check></td><td>
                  <Select aria-label={`${label} visibility`} disabled={!field} value={field?.visibility || "Team Members"} options={["Public","Logged in users","Team Members","Staff Only","Primary Staff Only"]} onChange={e=>setForm({...form,website:{...form.website!,fields:form.website!.fields.map(f=>f.key===key?{...f,visibility:e.target.value}:f)}})}/>
                </td></tr>;
              })}
            </tbody></table></div>
            <h3>Staff fields</h3>
            {[["name","Name"],["email","Email"],["phone","Mobile"]].map(([key,label])=>{
              const selected=form.website!.staff_fields||[], field=selected.find(f=>f.key===key);
              return <div className="form-grid" key={key}>
                <Check checked={!!field} onChange={e=>setForm({...form,website:{...form.website!,staff_fields:e.target.checked?[...selected,{key,visibility:"Team Members"}]:selected.filter(f=>f.key!==key)}})}>Include staff {label.toLowerCase()}</Check>
                <Field label={`Staff ${label.toLowerCase()} visibility`}><Select disabled={!field} value={field?.visibility||"Team Members"} options={["Public","Logged in users","Team Members","Staff Only","Primary Staff Only"]} onChange={e=>setForm({...form,website:{...form.website!,staff_fields:selected.map(f=>f.key===key?{...f,visibility:e.target.value}:f)}})}/></Field>
              </div>;
            })}
          </>}
          <h2>Printed Roster Fields</h2>
          <p>
            Choose the player information to display on printed team rosters.
          </p>
          {[
            ["name", "Name"],
            ["gender", "Gender"],
            ["birthdate", "Birth Date"],
            ["email", "Email"],
            ["phone", "Mobile"],
            ["address", "Address"],
            ["member_id", "Member ID"],
            ["invoice", "Invoiced"],
            ["balance", "Balance"],
          ].map(([key, label]) => (
            <Check
              key={key}
              checked={form.fields.includes(key)}
              onChange={(e) =>
                setForm({
                  ...form,
                  fields: e.target.checked
                    ? [...form.fields, key]
                    : form.fields.filter((f) => f !== key),
                })
              }
            >
              {label}
            </Check>
          ))}
          <Check
            checked={form.parent_contacts}
            onChange={(e) =>
              setForm({ ...form, parent_contacts: e.target.checked })
            }
          >
            Display parent contact details for youth members
          </Check>
          <h3>Roster Appearance</h3>
          <div className="form-grid">
            <Field label="Foreground color">
              <input
                type="color"
                value={form.foreground}
                onChange={(e) =>
                  setForm({ ...form, foreground: e.target.value })
                }
              />
            </Field>
            <Field label="Background color">
              <input
                type="color"
                value={form.background}
                onChange={(e) =>
                  setForm({ ...form, background: e.target.value })
                }
              />
            </Field>
          </div>
          <div className="form-actions">
            <Link to={"/programs/" + programId + "/teams"}>Cancel</Link>
            <Button disabled={saving}>{saving ? "Saving…" : "Save Settings"}</Button>
            {saved === JSON.stringify(form) && <span role="status">Roster settings saved.</span>}
          </div>
        </form>
      </main>
    </>
  );
}
export function TeamBuilder() {
  const { id } = useParams(),
    programs = useData<Program[]>("/programs", []),
    teams = useData<TeamRow[]>("/teams?program_id=" + id, []),
    registrations = useData<Registration[]>("/registrations", []),
    [pending, setPending] = useState<Record<string, string | null>>({}),
    [selected, setSelected] = useState<string[]>([]),
    [destination, setDestination] = useState(""),
    [search, setSearch] = useState(""),
    [gender, setGender] = useState(""),
    [waiver, setWaiver] = useState(""),
    [minAge, setMinAge] = useState(""),
    [maxAge, setMaxAge] = useState(""),
    [filters, setFilters] = useState(false),
    [teamPicker, setTeamPicker] = useState(false),
    [visibleTeams, setVisibleTeams] = useState<string[] | null>(null),
    [viewDraft, setViewDraft] = useState<string[]>([]),
    [review, setReview] = useState(false),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<TeamRow | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const current = programs.data.find((p) => p.id === id),
    scope = programs.data
      .filter((p) => p.id === id || p.parent_id === id)
      .map((p) => p.id),
    players = registrations.data.filter(
      (r) =>
        scope.includes(r.program_id) &&
        ["Confirmed", "Pending"].includes(r.status) &&
        ["Free Agent", "Team Player"].includes(r.role),
    );
  const age = (r: Registration) => {
    if (!r.birthdate) return null;
    const [y, m, d] = r.birthdate.split("-").map(Number),
      today = new Date();
    return (
      today.getFullYear() -
      y -
      (today.getMonth() + 1 < m ||
      (today.getMonth() + 1 === m && today.getDate() < d)
        ? 1
        : 0)
    );
  };
  const matched = players.filter(
    (r) =>
      name(r).toLowerCase().includes(search.toLowerCase()) &&
      (!gender || r.gender === gender) &&
      (!waiver ||
        (waiver === "Accepted"
          ? !!r.waiver_accepted_at
          : !r.waiver_accepted_at)) &&
      (!minAge || (age(r) !== null && age(r)! >= Number(minAge))) &&
      (!maxAge || (age(r) !== null && age(r)! <= Number(maxAge))),
  );
  const teamOf = (r: Registration) =>
    Object.hasOwn(pending, r.id) ? pending[r.id] : r.team_id;
  const columns = teams.data.filter((t) =>
    (visibleTeams || teams.data.slice(0, 5).map((t) => t.id)).includes(t.id),
  );
  const stage = (ids: string[], to: string | null) => {
    setError("");
    const changes = { ...pending };
    for (const key of ids) {
      const r = players.find((p) => p.id === key),
        target = teams.data.find((t) => t.id === to);
      if (!r) continue;
      if (target && (target.program_id !== r.program_id || target.locked)) {
        setError(
          "Choose an unlocked team in the player’s registration program.",
        );
        return;
      }
      if (teams.data.find((t) => t.id === r.team_id)?.locked) {
        setError("Unlock the player’s current team before moving them.");
        return;
      }
      if (to === r.team_id) delete changes[key];
      else changes[key] = to;
    }
    setPending(changes);
    setSelected([]);
  };
  const rosterCards = (teamId: string | null) =>
    matched
      .filter((r) => teamOf(r) === teamId)
      .sort((a, b) => name(a).localeCompare(name(b)))
      .map((r) => (
        <div
          className={
            "player-card" + (Object.hasOwn(pending, r.id) ? " changed" : "")
          }
          key={r.id}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)}
        >
          <GripVertical size={14} />
          <input
            aria-label={"Select " + name(r)}
            type="checkbox"
            checked={selected.includes(r.id)}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...selected, r.id]
                  : selected.filter((k) => k !== r.id),
              )
            }
          />
          <div>
            <Link to={"/members/" + r.person_id}>{name(r)}</Link>
            <small>
              {r.gender} · {age(r) === null ? "Age unknown" : age(r) + " yrs"}
            </small>
            <small>
              {programs.data.find((p) => p.id === r.program_id)?.name}
            </small>
          </div>
          {Object.hasOwn(pending, r.id) && (
            <span title="Unsaved change" className="change-dot" />
          )}
        </div>
      ));
  return (
    <div className="team-builder">
      <div className="builder-header">
        <h1>Team Builder</h1>
        <Link
          to={"/programs/" + id + "/teams"}
          onClick={(e) => {
            if (
              Object.keys(pending).length &&
              !window.confirm("Discard unsaved roster changes and exit?")
            )
              e.preventDefault();
          }}
        >
          <ArrowLeft size={16} />
          Exit
        </Link>
      </div>
      <div className="builder-tools">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search players by name"
        />
        <Button secondary onClick={() => setFilters(true)}>
          <Settings2 size={14} />
          Filter players
        </Button>
        <div className="builder-selection">
          <span>{selected.length} selected</span>
          <Select
            aria-label="Destination team"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            options={[
              { value: "", label: "Move selected to…" },
              { value: "unassigned", label: "Available players" },
              ...teams.data.map((t) => ({
                value: t.id,
                label: t.name + (t.locked ? " (locked)" : ""),
              })),
            ]}
          />
          <Button
            disabled={!selected.length || !destination}
            onClick={() =>
              stage(selected, destination === "unassigned" ? null : destination)
            }
          >
            Move <ArrowRight size={14} />
          </Button>
        </div>
        <Button
          disabled={!Object.keys(pending).length}
          onClick={() => setReview(true)}
        >
          Review Changes ({Object.keys(pending).length})
        </Button>
      </div>
      <ErrorBox error={error || teams.error || registrations.error} />
      <div className="builder-workspace">
        <aside
          className="available-players"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            stage([e.dataTransfer.getData("text/plain")], null);
          }}
        >
          <h2>
            Available players{" "}
            <span>{matched.filter((r) => !teamOf(r)).length}</span>
          </h2>
          <p>{current?.name}</p>
          <Check
            checked={
              matched.filter((r) => !teamOf(r)).length > 0 &&
              matched
                .filter((r) => !teamOf(r))
                .every((r) => selected.includes(r.id))
            }
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [
                      ...new Set([
                        ...selected,
                        ...matched.filter((r) => !teamOf(r)).map((r) => r.id),
                      ]),
                    ]
                  : selected.filter(
                      (k) => !matched.some((r) => r.id === k && !teamOf(r)),
                    ),
              )
            }
          >
            Select all available players
          </Check>
          <div className="player-stack">
            {rosterCards(null)}
            {!matched.some((r) => !teamOf(r)) && (
              <Empty>No available players match these filters.</Empty>
            )}
          </div>
        </aside>
        <section className="builder-teams">
          <div className="builder-title">
            <h2>Building teams for {current?.name}</h2>
            <div className="inline">
              <Button
                secondary
                onClick={() => {
                  setViewDraft(visibleTeams || columns.map((t) => t.id));
                  setTeamPicker(true);
                }}
              >
                View teams ({columns.length})
              </Button>
              <Button onClick={() => setAdding(true)}>Add new team</Button>
            </div>
          </div>
          <div className="team-columns">
            {columns.map((t) => (
              <section
                className="builder-team-column"
                key={t.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  stage([e.dataTransfer.getData("text/plain")], t.id);
                }}
              >
                <div className="builder-team-heading">
                  <span className="team-avatar small">
                    {t.name.slice(0, 2).toUpperCase()}
                  </span>
                  <Link to={"/teams/" + t.id}>{t.name}</Link>
                  {t.locked ? <Lock size={13} /> : null}
                  <button
                    aria-label={"Edit " + t.name}
                    onClick={() => setEditing(t)}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
                <small>{t.program_name}</small>
                <Check
                  checked={
                    matched.some((r) => teamOf(r) === t.id) &&
                    matched
                      .filter((r) => teamOf(r) === t.id)
                      .every((r) => selected.includes(r.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [
                            ...new Set([
                              ...selected,
                              ...matched
                                .filter((r) => teamOf(r) === t.id)
                                .map((r) => r.id),
                            ]),
                          ]
                        : selected.filter(
                            (k) =>
                              !matched.some(
                                (r) => r.id === k && teamOf(r) === t.id,
                              ),
                          ),
                    )
                  }
                >
                  Select all
                </Check>
                <h4>
                  Registered ({players.filter((r) => teamOf(r) === t.id).length}
                  )
                </h4>
                <div className="player-stack">{rosterCards(t.id)}</div>
              </section>
            ))}
          </div>
        </section>
      </div>
      {filters && (
        <Modal drawer title="Filter Players" onClose={() => setFilters(false)}>
          <div className="modal-body">
            <h3>Member data</h3>
            <div className="form-grid">
              <Field label="Minimum age">
                <input
                  type="number"
                  min={0}
                  value={minAge}
                  onChange={(e) => setMinAge(e.target.value)}
                />
              </Field>
              <Field label="Maximum age">
                <input
                  type="number"
                  min={0}
                  value={maxAge}
                  onChange={(e) => setMaxAge(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Gender">
              <Select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                options={[
                  { value: "", label: "Any gender" },
                  "Male",
                  "Female",
                  "Unknown",
                  "Non-binary",
                ]}
              />
            </Field>
            <h3>Registration data</h3>
            <Field label="Waiver status">
              <Select
                value={waiver}
                onChange={(e) => setWaiver(e.target.value)}
                options={[
                  { value: "", label: "Any waiver status" },
                  "Accepted",
                  "Not accepted",
                ]}
              />
            </Field>
            <div className="form-actions">
              <Button
                secondary
                onClick={() => {
                  setGender("");
                  setWaiver("");
                  setMinAge("");
                  setMaxAge("");
                }}
              >
                Clear Filters
              </Button>
              <Button onClick={() => setFilters(false)}>Apply</Button>
            </div>
          </div>
        </Modal>
      )}
      {teamPicker && (
        <Modal title="View Teams" onClose={() => setTeamPicker(false)}>
          <div className="modal-body">
            <p>Select up to 10 teams.</p>
            {teams.data.map((t) => (
              <Check
                key={t.id}
                disabled={viewDraft.length >= 10 && !viewDraft.includes(t.id)}
                checked={viewDraft.includes(t.id)}
                onChange={(e) =>
                  setViewDraft(
                    e.target.checked
                      ? [...viewDraft, t.id]
                      : viewDraft.filter((v) => v !== t.id),
                  )
                }
              >
                {t.name} · {t.program_name}
              </Check>
            ))}
            <div className="form-actions">
              <Button secondary onClick={() => setTeamPicker(false)}>
                Cancel
              </Button>
              <Button secondary onClick={() => setViewDraft([])}>
                Clear selection
              </Button>
              <Button
                onClick={() => {
                  setVisibleTeams(viewDraft);
                  setTeamPicker(false);
                }}
              >
                View teams
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {review && (
        <Modal title="Confirm Changes" wide onClose={() => setReview(false)}>
          <div className="modal-body">
            <p>Review the roster moves below before applying them.</p>
            <ErrorBox error={error} />
            <DataTable
              rows={Object.entries(pending).map(([key, to]) => ({
                id: key,
                player: players.find((p) => p.id === key),
                to,
              }))}
              columns={[
                {
                  key: "player",
                  label: "Player",
                  render: (r) => (r.player ? name(r.player) : "Unknown"),
                },
                {
                  key: "from",
                  label: "From",
                  render: (r) =>
                    teams.data.find((t) => t.id === r.player?.team_id)?.name ||
                    "Available players",
                },
                {
                  key: "to",
                  label: "To",
                  render: (r) =>
                    teams.data.find((t) => t.id === r.to)?.name ||
                    "Available players",
                },
              ]}
            />
            <div className="form-actions">
              <Button secondary onClick={() => setReview(false)}>
                Continue Editing
              </Button>
              <Button
                secondary
                onClick={() => {
                  setPending({});
                  setReview(false);
                }}
              >
                Discard Changes
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/roster/assign", {
                      method: "POST",
                      body: JSON.stringify({
                        changes: Object.entries(pending).map(([key, to]) => ({
                          registration_id: key,
                          expected_team_id:
                            players.find((p) => p.id === key)?.team_id ?? null,
                          team_id: to,
                        })),
                      }),
                    });
                    setPending({});
                    setReview(false);
                    teams.reload();
                    registrations.reload();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Applying…" : "Apply Changes"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {(adding || editing) && (
        <Modal
          title={editing ? "Edit Team Details" : "Add New Team"}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        >
          <TeamForm
            programs={programs.data.filter((p) => scope.includes(p.id))}
            programId={current?.grouped ? "" : id || ""}
            initial={editing || undefined}
            afterSaveAnother={teams.reload}
            done={() => {
              setAdding(false);
              setEditing(null);
              teams.reload();
            }}
            cancel={() => {
              setAdding(false);
              setEditing(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
