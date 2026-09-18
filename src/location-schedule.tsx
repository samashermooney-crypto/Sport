import { layoutLocationDay } from "./location-layout";
import { useEffect, useRef, useState } from "react";
import { Button, Check, DateInput, Field } from "./components";
import type { Activity, Location } from "./types";
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function LocationSchedule({
  events,
  locations,
  onEdit,
}: {
  events: Activity[];
  locations: Location[];
  onEdit: (event: Activity) => void;
}) {
  const [date, setDate] = useState(dateValue(new Date())),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const matchingLocations = locations.filter((l) =>
    l.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const day = new Date(date + "T00:00:00");
  const columns = locations
    .filter((l) => selected.includes(l.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 6 * 60;
  }, [columns.length > 0]);
  function shift(days: number) {
    const next = new Date(day);
    next.setDate(next.getDate() + days);
    setDate(dateValue(next));
  }
  function toggle(location: Location, checked: boolean) {
    const ids = [
      location.id,
      ...locations.filter((l) => l.parent_id === location.id).map((l) => l.id),
    ];
    setSelected((current) =>
      checked
        ? [...new Set([...current, ...ids])]
        : current.filter((id) => !ids.includes(id)),
    );
  }
  return (
    <section className="location-schedule">
      <details className="location-picker">
        <summary>Select locations ({selected.length})</summary>
        <Field label="Search locations">
          <input
            aria-label="Search locations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
        <div className="location-picker-options">
          {!matchingLocations.length && <p>No locations match your search.</p>}
          {matchingLocations.map((l) => (
            <Check
              key={l.id}
              checked={selected.includes(l.id)}
              onChange={(e) => toggle(l, e.target.checked)}
            >
              {l.parent_id ? "↳ " : ""}
              {l.name}
            </Check>
          ))}
        </div>
        <Button
          secondary
          onClick={() => setSelected(locations.map((l) => l.id))}
        >
          Select all
        </Button>{" "}
        <Button secondary onClick={() => setSelected([])}>
          Clear
        </Button>
      </details>
      <div className="split-toolbar">
        <h2>
          {day.toLocaleDateString(undefined, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </h2>
        <div className="inline wrap">
          <DateInput
            aria-label="Location schedule date"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
          />
          <Button
            secondary
            aria-label="Previous date"
            onClick={() => shift(-1)}
          >
            ‹
          </Button>
          <Button secondary aria-label="Next date" onClick={() => shift(1)}>
            ›
          </Button>
          <Button secondary onClick={() => setDate(dateValue(new Date()))}>
            Today
          </Button>
        </div>
      </div>
      {!columns.length ? (
        <p>Select a location to view its daily schedule.</p>
      ) : (
        <div
          ref={scroll}
          className="location-day-scroll"
          tabIndex={0}
          role="region"
          aria-label="Daily schedule by location"
        >
          <div
            className="location-day-grid"
            style={{
              gridTemplateColumns: `60px repeat(${columns.length}, minmax(220px,1fr))`,
            }}
          >
            <div className="location-column-heading">Time</div>
            {columns.map((l) => (
              <div className="location-column-heading" key={l.id}>
                {l.name}
              </div>
            ))}
            <div className="location-time-axis">
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour} style={{ top: hour * 60 }}>
                  {hour === 0
                    ? "12am"
                    : hour < 12
                      ? `${hour}am`
                      : hour === 12
                        ? "12pm"
                        : `${hour - 12}pm`}
                </div>
              ))}
            </div>
            {columns.map((location) => {
              const { intervals, laneCount } = layoutLocationDay(
                events,
                location.id,
                day,
              );
              return (
                <div
                  className="location-time-column"
                  key={location.id}
                  style={{ minWidth: Math.max(220, laneCount * 150) }}
                >
                  {intervals.map(({ event, start, height, lane }) => (
                    <button
                      key={event.id}
                      className="location-activity"
                      style={{
                        top: start,
                        height,
                        left: `${(lane * 100) / laneCount}%`,
                        width: `${100 / laneCount}%`,
                      }}
                      onClick={() => onEdit(event)}
                      title={`${event.title} · ${new Date(event.start_at).toLocaleTimeString()} – ${event.end_at ? new Date(event.end_at).toLocaleTimeString() : "End time TBD"}`}
                    >
                      <strong>{event.title}</strong>
                      <span>
                        {new Date(event.start_at).toLocaleTimeString(
                          undefined,
                          { hour: "numeric", minute: "2-digit" },
                        )}{" "}
                        · {event.end_at ? event.state : "End time TBD"}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
