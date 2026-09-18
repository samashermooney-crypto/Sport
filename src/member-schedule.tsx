import { MemberRsvp } from "./attendance";
import { useState } from "react";
import {
  Button,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
  Tabs,
  useData,
} from "./components";
import { EventResult, type GameResult } from "./event-result";

type ScheduleEvent = GameResult & {
  id: string;
  title: string;
  program_name: string;
  start_at: string;
  end_at: string;
  home_team: string | null;
  away_team: string | null;
  location: string | null;
  location_address: string | null;
  participants: { id: string; name: string }[];
};
type ScheduleData = {
  people: { id: string; name: string }[];
  events: ScheduleEvent[];
  organization: { name: string; timezone: string };
  week_start: number;
};
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) =>
  new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + days,
      12,
    ),
  );
export function MemberSchedule({ org }: { org: string }) {
  const { data, loading, error } = useData<ScheduleData | null>(
    `/member/${org}/schedule`,
    null,
  );
  if (loading) return <Loading />;
  if (error || !data)
    return <ErrorBox error={error || "Schedule unavailable"} />;
  return <ScheduleView org={org} data={data} />;
}
function ScheduleView({ org, data }: { org: string; data: ScheduleData }) {
  const timezone = data.organization.timezone;
  const localDay = (value: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
      new Date(value),
    );
  const today = localDay(new Date().toISOString());
  const [anchor, setAnchor] = useState(() => new Date(today + "T12:00:00Z"));
  const [view, setView] = useState("Calendar"),
    [period, setPeriod] = useState("Month"),
    [person, setPerson] = useState(""),
    [type, setType] = useState(""),
    [state, setState] = useState("");
  const [selected, setSelected] = useState<ScheduleEvent | null>(null);
  const first =
    period === "Month"
      ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 12))
      : period === "Week"
        ? addDays(anchor, -((anchor.getUTCDay() - data.week_start + 7) % 7))
        : anchor;
  const last =
    period === "Month"
      ? new Date(
          Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0, 12),
        )
      : period === "Week"
        ? addDays(first, 6)
        : first;
  const matches = data.events.filter(
    (e) =>
      (!person || e.participants.some((p) => p.id === person)) &&
      (!type || e.type === type) &&
      (!state || e.state === state),
  );
  const lastEventDay = (event: ScheduleEvent) =>
    event.end_at
      ? localDay(new Date(Date.parse(event.end_at) - 1).toISOString())
      : localDay(event.start_at);
  const onDay = (event: ScheduleEvent, key: string) =>
    localDay(event.start_at) <= key && lastEventDay(event) >= key;
  const rows = matches.filter(
    (e) =>
      localDay(e.start_at) <= dayKey(last) && lastEventDay(e) >= dayKey(first),
  );
  const gridStart =
    period === "Month"
      ? addDays(first, -((first.getUTCDay() - data.week_start + 7) % 7))
      : first;
  const cells = Array.from(
    { length: period === "Month" ? 42 : period === "Week" ? 7 : 1 },
    (_, i) => addDays(gridStart, i),
  );
  const time = (value: string) =>
    new Date(value).toLocaleTimeString("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    });
  const fullDate = (value: string) =>
    new Date(value).toLocaleString("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  const heading =
    period === "Month"
      ? anchor.toLocaleDateString("en-US", {
          timeZone: "UTC",
          month: "long",
          year: "numeric",
        })
      : `${first.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}${period === "Week" ? ` – ${last.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}` : ""}, ${anchor.getUTCFullYear()}`;
  function shift(direction: number) {
    setAnchor(
      period === "Month"
        ? new Date(
            Date.UTC(
              anchor.getUTCFullYear(),
              anchor.getUTCMonth() + direction,
              1,
              12,
            ),
          )
        : addDays(anchor, direction * (period === "Week" ? 7 : 1)),
    );
  }
  return (
    <>
      <h1>My schedule</h1>
      <p>All times {timezone.replaceAll("_", " ")}.</p>
      <div className="member-calendar-filters">
        <Field label="Family member">
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Me &amp; kids</option>
            {data.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Activity type">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Games &amp; events</option>
            <option value="Game">Games</option>
            <option value="Event">Events</option>
          </select>
        </Field>
        <Field label="Event status">
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All events</option>
            {[
              "Scheduled",
              "Rescheduled",
              "Completed",
              "Canceled",
              "Postponed",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Button
          type="button"
          secondary
          onClick={() => {
            setPerson("");
            setType("");
            setState("");
          }}
        >
          Clear filters
        </Button>
      </div>
      <div className="member-calendar-toolbar">
        <Tabs items={["Calendar", "List"]} value={view} onChange={setView} />
        <a
          href={`/api/member/${org}/schedule.ics?${new URLSearchParams({ person_id: person })}`}
          download
        >
          Download calendar
        </a>
      </div>
      <p className="muted">
        Calendar downloads include all dates and activity types for the selected
        family member.
      </p>
      <div className="member-calendar-toolbar">
        <div>
          <Button
            type="button"
            secondary
            aria-label="Previous period"
            onClick={() => shift(-1)}
          >
            ‹
          </Button>{" "}
          <Button
            type="button"
            secondary
            onClick={() => setAnchor(new Date(today + "T12:00:00Z"))}
          >
            Today
          </Button>{" "}
          <Button
            type="button"
            secondary
            aria-label="Next period"
            onClick={() => shift(1)}
          >
            ›
          </Button>
        </div>
        <h2 aria-live="polite">{heading}</h2>
        <Field label="Calendar period">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {["Month", "Week", "Day"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
      </div>
      {view === "List" ? (
        <DataTable
          rows={rows}
          pagination
          columns={[
            {
              key: "start",
              label: "Date / time",
              sort: (e) => e.start_at,
              render: (e) => (
                <>
                  {fullDate(e.start_at)}
                  <small className="cell-sub">
                    {e.end_at ? `Until ${fullDate(e.end_at)}` : "End time TBD"}
                  </small>
                </>
              ),
            },
            {
              key: "event",
              label: "Event",
              render: (e) => (
                <button className="text-button" onClick={() => setSelected(e)}>
                  {e.title}
                </button>
              ),
            },
            {
              key: "participants",
              label: "Family",
              render: (e) => e.participants.map((p) => p.name).join(", "),
            },
            { key: "location", label: "Location" },
            { key: "state", label: "Status" },
            {
              key: "score",
              label: "Score",
              render: (e) => <EventResult event={e} />,
            },
          ]}
        />
      ) : (
        <div
          className="member-calendar-scroll"
          role="region"
          aria-label="Member calendar"
          tabIndex={0}
        >
          {period !== "Day" && (
            <p className="calendar-scroll-hint">
              Scroll sideways to view the full week.
            </p>
          )}
          <div
            className={`member-calendar-grid ${period === "Day" ? "single-day" : ""}`}
          >
            {period !== "Day" &&
              Array.from({ length: 7 }, (_, i) => (
                <div className="calendar-weekday" key={i}>
                  {
                    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
                      (i + data.week_start) % 7
                    ]
                  }
                </div>
              ))}
            {cells.map((date) => {
              const key = dayKey(date);
              return (
                <section
                  key={key}
                  aria-label={key}
                  className={`member-calendar-day ${key === today ? "is-today" : ""} ${period === "Month" && date.getUTCMonth() !== anchor.getUTCMonth() ? "outside-month" : ""}`}
                >
                  <time dateTime={key}>{date.getUTCDate()}</time>
                  {matches
                    .filter((e) => onDay(e, key))
                    .map((e) => (
                      <button
                        key={e.id}
                        className="member-calendar-event"
                        onClick={() => setSelected(e)}
                      >
                        <span>{time(e.start_at)}</span>
                        <strong>{e.title}</strong>
                        <small>
                          {e.participants.map((p) => p.name).join(", ")}
                        </small>
                        {e.state !== "Scheduled" && <small>{e.state}</small>}
                      </button>
                    ))}
                </section>
              );
            })}
          </div>
        </div>
      )}
      {!rows.length && view === "Calendar" && (
        <p>No events match this period and these filters.</p>
      )}
      {selected && (
        <Modal title={selected.title} onClose={() => setSelected(null)}>
          <div className="modal-body">
            <h3>{selected.program_name}</h3>
            <p>
              {fullDate(selected.start_at)} –{" "}
              {selected.end_at ? fullDate(selected.end_at) : "End time TBD"}
            </p>
            <p>{selected.participants.map((p) => p.name).join(", ")}</p>
            {selected.home_team && (
              <p>
                {selected.home_team}
                {selected.away_team && ` vs. ${selected.away_team}`}
              </p>
            )}
            <p>{selected.state}</p>
            <MemberRsvp key={selected.id} org={org} eventId={selected.id} />
            <p>
              <EventResult event={selected} />
            </p>
            <p>{selected.location || "Location to be announced"}</p>
            {selected.location_address && <p>{selected.location_address}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
