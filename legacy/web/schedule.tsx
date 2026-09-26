import { LocationSchedule } from "./location-schedule";
import {
  localDateKey,
  matchesScheduleDate,
  scheduleDateBounds,
  scheduleDateGroup,
  scheduleDatePresets,
} from "./schedule-dates";
import type { ScheduleDatePreset, ScheduleGrouping } from "./schedule-dates";
import { ScheduleFilterPanel } from "./schedule-filter-panel";
import type { ScheduleStaff } from "./schedule-filters";
import {
  activityState,
  emptyScheduleFilters,
  matchesScheduleFilters,
} from "./schedule-filters";
import DOMPurify from "dompurify";
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { api, csv, shortDate } from "./api";
import {
  Button,
  DateInput,
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
import type { Activity, Program, Team, Location } from "./types";
import { EventResult } from "./event-result";
export function Schedule() {
  const { id } = useParams();
  return <ScheduleContent key={id || "global"} />;
}
function ScheduleContent() {
  const { id } = useParams(),
    { data, error, loading, reload } = useData<Activity[]>(
      "/events" + (id ? "?program_id=" + id : ""),
      [],
    ),
    { data: programs } = useData<Program[]>("/programs", []),
    {
      data: scheduleOptions,
      loading: filterTeamsLoading,
      error: filterTeamsError,
    } = useData<{ teams: Team[]; staff: ScheduleStaff[] }>(
      "/schedule/options",
      { teams: [], staff: [] },
    ),
    { data: locations } = useData<Location[]>("/locations", []);
  const { data: calendarRules } = useData<{ calendar_week_start: number }>(
    `/standings-rules/${id || "site"}`,
    { calendar_week_start: 0 },
  );
  const [view, setView] = useState("List View"),
    [datePreset, setDatePreset] = useState<ScheduleDatePreset>("Next 6 Months"),
    [grouping, setGrouping] = useState<ScheduleGrouping>("Month"),
    [dateFrom, setDateFrom] = useState(() => localDateKey(new Date())),
    [dateTo, setDateTo] = useState(() => localDateKey(new Date())),
    [filters, setFilters] = useState(emptyScheduleFilters),
    [filterOpen, setFilterOpen] = useState(false),
    [filterVersion, setFilterVersion] = useState(0),
    [search, setSearch] = useState(""),
    [month, setMonth] = useState(new Date()),
    [editing, setEditing] = useState<Activity | true | null>(null);
  const close = useCallback(() => setEditing(null), []),
    teams = scheduleOptions.teams,
    eventTeamIds = new Set(
      data.flatMap((e) => [e.home_team_id, e.away_team_id]),
    ),
    filterTeams = teams.filter(
      (t) => !id || t.program_id === id || eventTeamIds.has(t.id),
    ),
    filterTeamIds = new Set(filterTeams.map((t) => t.id)),
    filterStaff = scheduleOptions.staff.filter((p) =>
      p.team_ids.some((id) => filterTeamIds.has(id)),
    ),
    teamNames = new Map(teams.map((t) => [t.id, t.name])),
    p = programs.find((p) => p.id === id),
    filteredRows = data.filter(
      (e) =>
        e.title.toLowerCase().includes(search.trim().toLowerCase()) &&
        matchesScheduleFilters(e, filters, filterStaff),
    ),
    dateBounds = scheduleDateBounds(
      datePreset,
      new Date(),
      calendarRules.calendar_week_start,
      dateFrom,
      dateTo,
    ),
    dateError =
      view === "List View" && datePreset === "Custom Date Range" && !dateBounds
        ? "Choose a valid date range with the end date on or after the start date."
        : "",
    rows =
      view === "List View"
        ? filteredRows.filter((e) =>
            matchesScheduleDate(e.start_at, datePreset, dateBounds),
          )
        : filteredRows;
  const cells = Array.from(
    { length: 42 },
    (_, i) =>
      new Date(
        month.getFullYear(),
        month.getMonth(),
        1 -
          ((new Date(month.getFullYear(), month.getMonth(), 1).getDay() -
            calendarRules.calendar_week_start +
            7) %
            7) +
          i,
      ),
  );
  return (
    <>
      <PageTitle title={p ? p.name + " › Calendar" : "Global Schedule"} />
      {id && <ProgramNav id={id} active="Schedule" />}
      <main className="schedule-page">
        <ErrorBox error={error} />
        <ErrorBox error={filterTeamsError} />
        <div className="split-toolbar">
          <Link to={id ? `/programs/${id}/schedule/import` : "/schedule/import"}>Import schedule</Link>
          <Tabs
            items={["List View", "Calendar View", "Location View"]}
            value={view}
            onChange={setView}
          />
          <ExportButton
            disabled={
              loading ||
              !!error ||
              filterTeamsLoading ||
              !!filterTeamsError ||
              !!dateError
            }
            onClick={() =>
              csv(
                "schedule",
                ["Title", "Start", "End", "State", "Location", "Notes"],
                rows.map((e) => [
                  e.title,
                  e.start_at,
                  e.end_at,
                  e.state,
                  locations.find((l) => l.id === e.location_id)?.name,
                  e.notes,
                ]),
              )
            }
          />
        </div>
        <div className="split-toolbar schedule-action-toolbar">
          <div className="inline wrap">
            {view === "List View" && (
              <div className="schedule-range-controls">
                <Field label="Filter by Date">
                  <Select
                    aria-label="Filter by Date"
                    options={[...scheduleDatePresets]}
                    value={datePreset}
                    onChange={(e) => {
                      setDatePreset(e.target.value as ScheduleDatePreset);
                      setFilterVersion((v) => v + 1);
                    }}
                  />
                </Field>
                <Field label="Group By">
                  <Select
                    aria-label="Group By"
                    options={["None", "Week", "Two Weeks", "Month"]}
                    value={grouping}
                    onChange={(e) => {
                      setGrouping(e.target.value as ScheduleGrouping);
                      setFilterVersion((v) => v + 1);
                    }}
                  />
                </Field>
                {datePreset === "Custom Date Range" && (
                  <>
                    <Field label="From date">
                      <DateInput
                        aria-label="Schedule from date"
                        value={dateFrom}
                        onChange={(e) => {
                          setDateFrom(e.target.value);
                          setFilterVersion((v) => v + 1);
                        }}
                      />
                    </Field>
                    <Field label="Through date">
                      <DateInput
                        aria-label="Schedule through date"
                        value={dateTo}
                        onChange={(e) => {
                          setDateTo(e.target.value);
                          setFilterVersion((v) => v + 1);
                        }}
                      />
                    </Field>
                  </>
                )}
              </div>
            )}
            <Button
              secondary
              disabled={filterTeamsLoading || !!filterTeamsError}
              onClick={() => setFilterOpen(true)}
            >
              Filters
              {filters.teams.length +
                filters.staff.length +
                filters.types.length +
                filters.states.length +
                Number(!!filters.from) +
                Number(!!filters.to) >
              0
                ? " (active)"
                : ""}
            </Button>
            <SearchBox
              placeholder="Quick search"
              value={search}
              onChange={setSearch}
            />
            <span className="subtle">
              {rows.length} {rows.length === 1 ? "activity" : "activities"}
            </span>
          </div>
          <Button
            disabled={filterTeamsLoading || !!filterTeamsError}
            onClick={() => setEditing(true)}
          >
            <Plus size={14} />
            Create
          </Button>
        </div>
        <ErrorBox error={dateError} />
        {loading || filterTeamsLoading ? (
          <Loading />
        ) : error || filterTeamsError ? null : view === "Location View" ? (
          <LocationSchedule
            events={rows}
            locations={locations}
            onEdit={setEditing}
          />
        ) : view === "List View" ? (
          <DataTable
            key={filterVersion}
            initialPageSize={100}
            groupBy={
              grouping === "None"
                ? undefined
                : (e) =>
                    scheduleDateGroup(
                      e.start_at,
                      grouping,
                      calendarRules.calendar_week_start,
                      dateBounds?.start || new Date(),
                    )
            }
            pagination
            rows={rows}
            columns={[
              {
                key: "title",
                label: "Title",
                sort: (e) => e.title,
                render: (e) => (
                  <button className="text-button" onClick={() => setEditing(e)}>
                    {e.title}
                  </button>
                ),
              },
              {
                key: "date",
                label: "Date",
                sort: (e) => e.start_at,
                render: (e) => shortDate(e.start_at),
              },
              {
                key: "start",
                label: "Start Time",
                render: (e) =>
                  new Date(e.start_at).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
              },
              {
                key: "end",
                label: "End Time",
                render: (e) =>
                  e.end_at
                    ? new Date(e.end_at).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "TBD",
              },
              {
                key: "home",
                label: "Home Team",
                render: (e) => teamNames.get(e.home_team_id || "") ?? "—",
              },
              {
                key: "away",
                label: "Away Team",
                render: (e) => teamNames.get(e.away_team_id || "") ?? "—",
              },
              {
                key: "location",
                label: "Location | Sublocation",
                render: (e) =>
                  locations.find((l) => l.id === e.location_id)?.name ?? "—",
              },
              { key: "state", label: "State", render: activityState },
              {
                key: "score",
                label: "Result",
                render: (e) => <EventResult event={e} />,
              },
              {
                key: "published",
                label: "Visibility",
                render: (e) => (e.published ? "Published" : "Unpublished"),
              },
              {
                key: "notes",
                label: "Notes",
                render: (e) =>
                  e.notes ? (
                    <div
                      className="schedule-notes"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(e.notes, {
                          ALLOWED_TAGS: [
                            "a",
                            "b",
                            "br",
                            "em",
                            "hr",
                            "i",
                            "p",
                            "strong",
                          ],
                          ALLOWED_ATTR: ["href", "title"],
                          ALLOW_DATA_ATTR: false,
                        }),
                      }}
                    />
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
        ) : (
          <>
            <div className="calendar-heading">
              <div className="inline">
                <Button
                  secondary
                  aria-label="Previous month"
                  onClick={() =>
                    setMonth(
                      new Date(month.getFullYear(), month.getMonth() - 1, 1),
                    )
                  }
                >
                  <ChevronLeft size={14} />
                </Button>
                <Button
                  secondary
                  aria-label="Next month"
                  onClick={() =>
                    setMonth(
                      new Date(month.getFullYear(), month.getMonth() + 1, 1),
                    )
                  }
                >
                  <ChevronRight size={14} />
                </Button>
                <Button secondary onClick={() => setMonth(new Date())}>
                  today
                </Button>
              </div>
              <h2>
                {month.toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })}
              </h2>
              <span>month</span>
            </div>
            <p className="calendar-scroll-hint">
              Scroll sideways to view the full week.
            </p>
            <div
              className="calendar-scroll"
              role="region"
              aria-label="Monthly calendar"
              tabIndex={0}
            >
              <div className="calendar-grid">
                {Array.from(
                  { length: 7 },
                  (_, i) =>
                    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
                      (i + calendarRules.calendar_week_start) % 7
                    ],
                ).map((d) => (
                  <div className="calendar-weekday" key={d}>
                    {d}
                  </div>
                ))}
                {cells.map((date) => {
                  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                  return (
                    <div
                      className={
                        "calendar-cell " +
                        (date.getMonth() !== month.getMonth() ? "outside" : "")
                      }
                      key={dateKey}
                    >
                      <span>{date.getDate()}</span>
                      {rows
                        .filter(
                          (e) =>
                            new Date(e.start_at).toDateString() ===
                            date.toDateString(),
                        )
                        .map((e) => (
                          <button
                            onClick={() => setEditing(e)}
                            key={e.id}
                            className="calendar-event"
                          >
                            {new Date(e.start_at).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                            })}{" "}
                            {e.title}
                          </button>
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>
      {filterOpen && (
        <ScheduleFilterPanel
          value={filters}
          teams={filterTeams}
          staff={filterStaff}
          onClose={() => setFilterOpen(false)}
          onApply={(value) => {
            setFilters(value);
            setFilterVersion((v) => v + 1);
            setFilterOpen(false);
          }}
        />
      )}
      {editing && (
        <Modal
          title={editing === true ? "Create Activity" : "Edit Activity"}
          onClose={close}
        >
          <ActivityForm
            existing={editing === true ? null : editing}
            programId={id ?? ""}
            programs={programs}
            teams={teams}
            locations={locations}
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
function ActivityForm({
  existing,
  programId,
  programs,
  teams,
  locations,
  cancel,
  done,
}: {
  existing: Activity | null;
  programId: string;
  programs: Program[];
  teams: Team[];
  locations: Location[];
  cancel: () => void;
  done: () => void;
}) {
  const local = (s: string) => {
    if (!s) return "";
    const d = new Date(s);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const [tbdEnd, setTbdEnd] = useState(!!existing && !existing.end_at);
  const [form, setForm] = useState({
      program_id: existing?.program_id ?? programId,
      type: existing?.type ?? "Game",
      title: existing?.title ?? "",
      home_team_id: existing?.home_team_id ?? "",
      away_team_id: existing?.away_team_id ?? "",
      location_id: existing?.location_id ?? "",
      start_at: existing ? local(existing.start_at) : "",
      end_at: existing ? local(existing.end_at) : "",
      notes: existing?.notes ?? "",
      description: existing?.description ?? "",
      location_note: existing?.location_note ?? "",
      event_type: existing?.type === "Event" ? existing.activity_type || "OTHER" : "OTHER",
      published: !!existing?.published,
      state: existing?.state ?? "Scheduled",
      home_score: existing?.home_score ?? null,
      away_score: existing?.away_score ?? null,
      game_type: existing?.game_type ?? "Regular Season",
      overtime: existing?.overtime ?? false,
      forfeit: existing?.forfeit ?? "None",
      exclude_home: existing?.exclude_home ?? false,
      exclude_away: existing?.exclude_away ?? false,
      match_scores: (existing?.match_scores ?? []) as {
        home: number | null;
        away: number | null;
      }[],
    }),
    [otherPrograms, setOtherPrograms] = useState(
      !!existing &&
        teams.some(
          (t) =>
            [existing.home_team_id, existing.away_team_id].includes(t.id) &&
            t.program_id !== existing.program_id,
        ),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const programTeams = useData<Team[]>(
    "/teams?program_id=" + encodeURIComponent(form.program_id || "none"),
    [],
  );
  const scopedTeams = programTeams.data.filter(
    (t) => t.program_id === form.program_id,
  );
  const available = otherPrograms
    ? [...new Map([...teams, ...scopedTeams].map((t) => [t.id, t])).values()]
    : scopedTeams;
  return (
    <form
      className="modal-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(existing ? "/events/" + existing.id : "/events", {
            method: existing ? "PUT" : "POST",
            body: JSON.stringify({
              ...form,
              ...(form.type === "Event" ? { activity_type: form.event_type } : {}),
              home_team_id: form.home_team_id || null,
              away_team_id: form.away_team_id || null,
              location_id: form.location_id || null,
              start_at: new Date(form.start_at).toISOString(),
              end_at: tbdEnd ? "" : new Date(form.end_at).toISOString(),
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
      <Field label="Activity type" required>
        <Select
          options={["Game", "Event"]}
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value })}
        />
      </Field>
      {form.type === "Event" && <Field label="Event type">
        <Select value={form.event_type}
          options={["Game", "Tournament", "Scrimmage", "Practice", "Meeting", "Class", "Camp", "League", "Training", "Other"].map((label) => ({ label, value: label.toUpperCase() }))}
          onChange={(e) => setForm({ ...form, event_type: e.target.value })} />
      </Field>}
      <Field label="Program" required>
        <Select
          required
          options={[
            { value: "", label: "Select a program" },
            ...programs
              .filter((p) => !p.grouped)
              .map((p) => ({ value: p.id, label: p.name })),
          ]}
          value={form.program_id}
          onChange={(e) =>
            setForm({
              ...form,
              program_id: e.target.value,
              home_team_id: "",
              away_team_id: "",
              home_score: null,
              away_score: null,
              match_scores: [],
              forfeit: "None",
              game_type: "Regular Season",
            })
          }
        />
      </Field>
      {form.type === "Game" && (
        <>
          <Field label="Game Type">
            <Select
              value={form.game_type}
              options={[
                "Regular Season",
                "Playoff",
                "Championship",
                "Quarterfinals",
                "Semifinals",
                "Final",
                ...(programs.find((p) => p.id === form.program_id)?.type ===
                "Tournament"
                  ? ["Pool Play"]
                  : []),
                "Tournament",
                "Exhibition",
                "Scrimmage",
              ]}
              onChange={(e) => setForm({ ...form, game_type: e.target.value })}
            />
          </Field>
          <Check
            checked={otherPrograms}
            disabled={programTeams.loading || !!programTeams.error}
            onChange={(e) => {
              setOtherPrograms(e.target.checked);
              if (!e.target.checked)
                setForm({
                  ...form,
                  home_team_id: scopedTeams.some(
                    (t) =>
                      t.id === form.home_team_id &&
                      t.program_id === form.program_id,
                  )
                    ? form.home_team_id
                    : "",
                  away_team_id: scopedTeams.some(
                    (t) =>
                      t.id === form.away_team_id &&
                      t.program_id === form.program_id,
                  )
                    ? form.away_team_id
                    : "",
                });
            }}
          >
            Show teams from other programs
          </Check>
        </>
      )}
      <Field label="Custom title" required>
        <input
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </Field>
      <div className="form-grid">
        {(form.type === "Game"
          ? ["home_team_id", "away_team_id"]
          : ["home_team_id"]
        ).map((key, i) => (
          <Field
            label={
              form.type === "Game" ? (i ? "Away Team" : "Home Team") : "Team"
            }
            key={key}
          >
            <Select
              disabled={programTeams.loading || !!programTeams.error}
              required={form.type === "Game"}
              options={[
                { value: "", label: "Select a team" },
                ...available.map((t) => ({
                  value: t.id,
                  label: otherPrograms
                    ? `${t.name} — ${programs.find((p) => p.id === t.program_id)?.name || "Program"}`
                    : t.name,
                })),
              ]}
              value={form[key as "home_team_id"]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <Field label="Location">
        <Select
          options={[
            { value: "", label: "Select a location" },
            ...locations.map((l) => ({ value: l.id, label: l.name })),
          ]}
          value={form.location_id}
          onChange={(e) => setForm({ ...form, location_id: e.target.value })}
        />
      </Field>
      <div className="form-grid activity-dates">
        <Field label="Start Date & Time" required>
          <input
            required
            type="datetime-local"
            value={form.start_at}
            onInput={(e) =>
              setForm({ ...form, start_at: e.currentTarget.value })
            }
            onChange={(e) => setForm({ ...form, start_at: e.target.value })}
          />
        </Field>
        <Field label="End Date & Time" required={!tbdEnd}>
          <input
            required={!tbdEnd}
            disabled={tbdEnd}
            type="datetime-local"
            value={form.end_at}
            onInput={(e) => setForm({ ...form, end_at: e.currentTarget.value })}
            onChange={(e) => setForm({ ...form, end_at: e.target.value })}
          />
        </Field>
      </div>
      <Check checked={tbdEnd} onChange={(e) => setTbdEnd(e.target.checked)}>
        TBD end
      </Check>
      {tbdEnd && <p className="subtle">With no end time, conflict checking uses the known start time.</p>}
      <Field
        label="Notes"
        hint={`${form.notes.length}/500 · Allowed HTML: <a> <b> <br> <em> <hr> <i> <p> <strong>`}
      >
        <textarea
          maxLength={500}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>
      {form.type === "Event" && <>
        <Field label="Description" hint={`${form.description.length}/10000`}>
          <textarea maxLength={10000} value={form.description}
            onInput={(e) => setForm({ ...form, description: e.currentTarget.value })}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Location note" hint={`${form.location_note.length}/1000`}>
          <textarea maxLength={1000} value={form.location_note}
            onInput={(e) => setForm({ ...form, location_note: e.currentTarget.value })}
            onChange={(e) => setForm({ ...form, location_note: e.target.value })} />
        </Field>
      </>}
      <Field label="Activity State">
        <Select
          options={[
            "Scheduled",
            "Rescheduled",
            "Completed",
            "Canceled",
            "Postponed",
          ]}
          value={form.state}
          onChange={(e) => setForm({ ...form, state: e.target.value })}
        />
      </Field>
      {form.type === "Game" && form.state === "Completed" && (
        <>
          <Field label="Forfeit">
            <Select
              value={form.forfeit}
              options={[
                { value: "None", label: "No forfeit" },
                { value: "Home", label: "Home team forfeited" },
                { value: "Away", label: "Away team forfeited" },
                { value: "Both", label: "Both teams forfeited" },
              ]}
              onChange={(e) => setForm({ ...form, forfeit: e.target.value })}
            />
          </Field>
          <Check
            checked={form.overtime}
            disabled={form.forfeit !== "None"}
            onChange={(e) => setForm({ ...form, overtime: e.target.checked })}
          >
            Game finished in overtime
          </Check>
          <Field label="Score Entry">
            <Select
              value={
                form.match_scores.length ? "Individual Games" : "Final Score"
              }
              options={["Final Score", "Individual Games"]}
              onChange={(e) =>
                setForm({
                  ...form,
                  match_scores:
                    e.target.value === "Individual Games"
                      ? [{ home: null, away: null }]
                      : [],
                })
              }
            />
          </Field>
          {!form.match_scores.length ? (
            <div className="form-grid">
              {["home_score", "away_score"].map((key, i) => (
                <Field label={i ? "Away Score" : "Home Score"} key={key}>
                  <input
                    min="0"
                    type="number"
                    required={form.forfeit === "None"}
                    value={form[key as "home_score"] ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        [key]: e.target.value === "" ? null : +e.target.value,
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          ) : (
            <div className="match-score-editor">
              <p className="muted">
                Enter each game in the match. Match standings use games won;
                game standings use the total points scored.
              </p>
              {form.match_scores.map((score, index) => (
                <div className="form-grid match-score-row" key={index}>
                  {(["home", "away"] as const).map((side) => (
                    <Field
                      key={side}
                      label={`${side === "home" ? "Home" : "Away"} score — Game ${index + 1}`}
                    >
                      <input
                        type="number"
                        required
                        min={0}
                        max={100000}
                        value={score[side] ?? ""}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            match_scores: form.match_scores.map((s, i) =>
                              i === index
                                ? {
                                    ...s,
                                    [side]:
                                      e.target.value === ""
                                        ? null
                                        : e.target.valueAsNumber,
                                  }
                                : s,
                            ),
                          })
                        }
                      />
                    </Field>
                  ))}
                  <Button
                    type="button"
                    secondary
                    onClick={() =>
                      setForm({
                        ...form,
                        match_scores: form.match_scores.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    Remove game {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                secondary
                disabled={form.match_scores.length >= 31}
                onClick={() =>
                  setForm({
                    ...form,
                    match_scores: [
                      ...form.match_scores,
                      { home: null, away: null },
                    ],
                  })
                }
              >
                Add Game Score
              </Button>
            </div>
          )}
          <Check
            checked={form.exclude_home}
            onChange={(e) =>
              setForm({ ...form, exclude_home: e.target.checked })
            }
          >
            Exclude home team result from standings
          </Check>
          <Check
            checked={form.exclude_away}
            onChange={(e) =>
              setForm({ ...form, exclude_away: e.target.checked })
            }
          >
            Exclude away team result from standings
          </Check>
        </>
      )}
      <Check
        checked={form.published}
        onChange={(e) => setForm({ ...form, published: e.target.checked })}
      >
        Publish this activity
      </Check>
      <div className="form-actions">
        <Button type="button" secondary onClick={cancel}>
          Discard Changes
        </Button>
        <ErrorBox error={programTeams.error} />
        <Button disabled={busy || programTeams.loading || !!programTeams.error}>
          {existing ? "Save Changes" : "Create Activity"}
        </Button>
      </div>
    </form>
  );
}
