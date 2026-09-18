import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "./api";
import {
  Button,
  Check,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  PageTitle,
  useData,
} from "./components";
type Person = {
  person_id: string;
  first_name: string;
  last_name: string;
  team_name: string;
  rsvp: string;
  checked_in_at: string | null;
  version: number;
};
type Roster = {
  event: {
    id: string;
    title: string;
    program_name: string;
    start_at: string;
    state: string;
  };
  rows: Person[];
  staff_rows?: Person[];
};
const empty: Roster = {
  event: { id: "", title: "", program_name: "", start_at: "", state: "" },
  rows: [],
};
export function MemberRsvp({ org, eventId }: { org: string; eventId: string }) {
  const roster = useData<Roster>(
      `/member/${org}/activities/${eventId}/attendance`,
      empty,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (roster.loading) return <Loading />;
  return (
    <section>
      <h3>RSVP</h3>
      <ErrorBox error={error || roster.error} />
      {roster.data.rows.map((p) => (
        <Field key={p.person_id} label={`${p.first_name} ${p.last_name}`}>
          <select
            disabled={busy || roster.data.event.state === "Canceled"}
            value={p.rsvp}
            onChange={async (e) => {
              setBusy(true);
              setError("");
              try {
                await api(
                  `/member/${org}/activities/${eventId}/rsvp/${p.person_id}`,
                  {
                    method: "PUT",
                    body: JSON.stringify({
                      version: p.version,
                      rsvp: e.target.value,
                    }),
                  },
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                roster.reload();
                setBusy(false);
              }
            }}
          >
            {["", "Yes", "No", "Maybe"].map((s) => (
              <option key={s} value={s}>
                {s || "Not responded"}
              </option>
            ))}
          </select>
          {p.checked_in_at && <span>Checked in</span>}
        </Field>
      ))}
      {!!roster.data.staff_rows?.length && (
        <section>
          <h3>Team check-in</h3>
          {roster.data.staff_rows.map((p) => (
            <Check
              key={p.person_id}
              disabled={busy || roster.data.event.state === "Canceled"}
              checked={!!p.checked_in_at}
              onChange={async (e) => {
                setBusy(true);
                setError("");
                try {
                  await api(
                    `/member/${org}/activities/${eventId}/check-in/${p.person_id}`,
                    {
                      method: "PUT",
                      body: JSON.stringify({
                        version: p.version,
                        checked_in: e.target.checked,
                      }),
                    },
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  roster.reload();
                  setBusy(false);
                }
              }}
            >
              {p.first_name} {p.last_name}
              {p.team_name ? ` · ${p.team_name}` : ""}
            </Check>
          ))}
        </section>
      )}
      {!roster.data.rows.length &&
        !roster.data.staff_rows?.length &&
        !roster.error && (
          <p>No eligible player registrations for this activity.</p>
        )}
    </section>
  );
}
export function ActivityAttendance() {
  const { id } = useParams(),
    roster = useData<Roster>(`/activities/${id}/attendance`, empty),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <PageTitle title="Activity Attendance" />
      <main className="content-page activity-attendance">
        <ErrorBox error={error || roster.error} />
        {roster.loading ? (
          <Loading />
        ) : (
          <>
            <h2>{roster.data.event.title}</h2>
            <p>{roster.data.event.program_name}</p>
            <DataTable
              rows={roster.data.rows.map((p) => ({ ...p, id: p.person_id }))}
              columns={[
                {
                  key: "first_name",
                  label: "Player",
                  render: (p) => `${p.first_name} ${p.last_name}`,
                },
                { key: "team_name", label: "Team" },
                {
                  key: "rsvp",
                  label: "RSVP",
                  render: (p) => p.rsvp || "Not responded",
                },
                {
                  key: "checked_in_at",
                  label: "Checked In",
                  render: (p) => (
                    <Check
                      disabled={busy || roster.data.event.state === "Canceled"}
                      checked={!!p.checked_in_at}
                      onChange={async (e) => {
                        setBusy(true);
                        setError("");
                        try {
                          await api(
                            `/activities/${id}/attendance/${p.person_id}`,
                            {
                              method: "PUT",
                              body: JSON.stringify({
                                version: p.version,
                                checked_in: e.target.checked,
                              }),
                            },
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          roster.reload();
                          setBusy(false);
                        }
                      }}
                    >
                      {p.first_name} {p.last_name}
                    </Check>
                  ),
                },
              ]}
            />
          </>
        )}
        <div className="form-actions start">
          <Link to="/reports/attendance">Attendance report</Link>
        </div>
      </main>
    </>
  );
}
type ReportRow = Person & {
  roster_status: string;
  id: string;
  event_id: string;
  title: string;
  program_name: string;
  start_at: string;
};
type Report = {
  rows: ReportRow[];
  summary: Record<string, number>;
  timezone: string;
  programs: {
    id: string;
    name: string;
    participants: number;
    yes: number;
    no: number;
    maybe: number;
    not_responded: number;
    checked_in: number;
  }[];
};
export function AttendanceReport() {
  const defaults = useData<{ from: string; to: string; timezone: string }>(
    "/reports/attendance/options",
    { from: "", to: "", timezone: "UTC" },
  );
  if (defaults.loading) return <Loading />;
  if (defaults.error) return <ErrorBox error={defaults.error} />;
  return <AttendanceReportView defaults={defaults.data} />;
}
function AttendanceReportView({
  defaults,
}: {
  defaults: { from: string; to: string; timezone: string };
}) {
  const programs = useData<{ id: string; name: string }[]>("/programs", []),
    [program, setProgram] = useState(""),
    [from, setFrom] = useState(defaults.from),
    [to, setTo] = useState(defaults.to),
    [eventType, setEventType] = useState(""),
    [title, setTitle] = useState(""),
    [exportQuery, setExportQuery] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [report, setReport] = useState<Report | null>(null);
  return (
    <>
      <PageTitle title="Attendance" />
      <main className="content-page">
        <ErrorBox error={error || programs.error} />
        <p>
          Activity dates and times use {defaults.timezone}. The default range is
          this week, Monday through Sunday.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const query = new URLSearchParams({
                from,
                to,
                program_id: program,
                name,
                event_type: eventType,
                title,
              }).toString();
              setReport(await api(`/reports/attendance?${query}`));
              setExportQuery(query);
            } catch (e) {
              setError((e as Error).message);
              setReport(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <Field label="Activity start from">
              <input
                type="date"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Through">
              <input
                type="date"
                required
                min={from}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label="Program">
              <select
                value={program}
                onChange={(e) => setProgram(e.target.value)}
              >
                <option value="">All programs</option>
                {programs.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Event or Game">
              <select
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
              >
                <option value="">All activities</option>
                <option>Game</option>
                <option>Event</option>
              </select>
            </Field>
            <Field label="Activity title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Player name">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button disabled={busy}>Run Report</Button>
        </form>
        {report && (
          <section className="attendance-report-results" aria-label="Attendance report results">
            <p>
              {(
                [
                  ["summary", "Export - Attendance Summary"],
                  ["programs", "Export - Program Attendance"],
                  ["players", "Export - Player Attendance"],
                  ["checkins", "Export - Check-Ins"],
                ] as const
              ).map(([section, label]) => (
                <span key={section}>
                  <a
                    href={`/api/reports/attendance.csv?${exportQuery}&section=${section}`}
                  >
                    {label}
                  </a>
                  {" · "}
                </span>
              ))}
            </p>
            <h2>Attendance Summary</h2>
            <p>
              Participant activity entries: {report.summary.participants} · RSVP
              Yes: {report.summary.yes} · No: {report.summary.no} · Maybe:{" "}
              {report.summary.maybe} · Not responded:{" "}
              {report.summary.not_responded} · Checked in:{" "}
              {report.summary.checked_in}
            </p>
            <h2>Program Attendance</h2>
            <DataTable
              rows={report.programs}
              columns={[
                { key: "name", label: "Program" },
                { key: "participants", label: "Participants" },
                { key: "yes", label: "RSVP Yes" },
                { key: "no", label: "RSVP No" },
                { key: "maybe", label: "RSVP Maybe" },
                { key: "not_responded", label: "Not Responded" },
                { key: "checked_in", label: "Checked In" },
              ]}
            />
            <h2>Player Attendance</h2>
            <p>Recorded attendance is retained for former roster members.</p>
            <DataTable
              rows={report.rows}
              columns={[
                {
                  key: "first_name",
                  label: "Player",
                  render: (r) => `${r.first_name} ${r.last_name}`,
                },
                { key: "program_name", label: "Program" },
                { key: "roster_status", label: "Roster" },
                {
                  key: "title",
                  label: "Activity",
                  render: (r) => (
                    <Link to={`/activities/${r.event_id}/attendance`}>
                      {r.title}
                    </Link>
                  ),
                },
                {
                  key: "start_at",
                  label: "Start",
                  render: (r) =>
                    new Date(r.start_at).toLocaleString(undefined, {
                      timeZone: report.timezone,
                    }),
                },
                {
                  key: "rsvp",
                  label: "RSVP",
                  render: (r) => r.rsvp || "Not responded",
                },
                {
                  key: "checked_in_at",
                  label: "Checked In",
                  render: (r) => (r.checked_in_at ? "Yes" : "No"),
                },
              ]}
            />
          </section>
        )}
      </main>
    </>
  );
}
