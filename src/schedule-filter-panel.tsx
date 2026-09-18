import { useState } from "react";
import { Button, Check, ErrorBox, Field, Modal } from "./components";
import { emptyScheduleFilters, scheduleStates } from "./schedule-filters";
import type { ScheduleFilters, ScheduleStaff } from "./schedule-filters";
import type { Team } from "./types";

export function ScheduleFilterPanel({
  value,
  teams,
  staff,
  onApply,
  onClose,
}: {
  value: ScheduleFilters;
  teams: Team[];
  staff: ScheduleStaff[];
  onApply: (filters: ScheduleFilters) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  function group(
    key: "teams" | "types" | "states" | "staff",
    label: string,
    options: { id: string; name: string }[],
  ) {
    return (
      <fieldset className="schedule-filter-group">
        <legend>{label}</legend>
        <button
          type="button"
          className="text-button"
          onClick={() => setDraft({ ...draft, [key]: [] })}
        >
          Clear {label.toLowerCase()}
        </button>
        <details className="schedule-filter-select">
          <summary>
            {draft[key].length
              ? `${draft[key].length} selected`
              : `Select ${label.toLowerCase()}(s)`}
          </summary>
          {key === "teams" && (
            <input
              type="search"
              aria-label="Search filter teams"
              placeholder="Search teams"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          <div className="schedule-filter-options">
            {options.map((option) => (
              <Check
                key={option.id}
                checked={draft[key].includes(option.id)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: e.target.checked
                      ? [...draft[key], option.id]
                      : draft[key].filter((id) => id !== option.id),
                  })
                }
              >
                {option.name}
              </Check>
            ))}
              {!options.length && <p>{key === "staff" ? "No staff members are assigned to these teams." : "No teams match your search."}</p>}
          </div>
        </details>
      </fieldset>
    );
  }
  return (
    <Modal title="Filters" drawer onClose={onClose}>
      <form
        className="modal-body schedule-filter-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.from && draft.to && draft.from > draft.to) {
            setError("The start-time range must end at or after it begins.");
            return;
          }
          onApply(draft);
        }}
      >
        {group(
          "teams",
          "Team",
          teams
            .filter((t) =>
              t.name.toLowerCase().includes(search.trim().toLowerCase()),
            )
            .map((t) => ({ id: t.id, name: t.name })),
        )}
        {group(
          "types",
          "Activity Type",
          ["Game", "Event"].map((name) => ({ id: name, name })),
        )}
        {group("staff", "Staff Member Name", staff)}
        <fieldset className="schedule-filter-group">
          <legend>Start Times</legend>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft({ ...draft, from: "", to: "" });
              setError("");
            }}
          >
            Clear start times
          </button>
          <div className="form-grid">
            <Field label="From">
              <input
                aria-label="Start time from"
                type="time"
                value={draft.from}
                onInput={(e) => {
                  setDraft({ ...draft, from: e.currentTarget.value });
                  setError("");
                }}
                onChange={(e) => {
                  setDraft({ ...draft, from: e.target.value });
                  setError("");
                }}
              />
            </Field>
            <Field label="To">
              <input
                aria-label="Start time to"
                type="time"
                value={draft.to}
                onInput={(e) => {
                  setDraft({ ...draft, to: e.currentTarget.value });
                  setError("");
                }}
                onChange={(e) => {
                  setDraft({ ...draft, to: e.target.value });
                  setError("");
                }}
              />
            </Field>
          </div>
        </fieldset>
        {group(
          "states",
          "Activity State",
          scheduleStates.map((name) => ({ id: name, name })),
        )}
        <ErrorBox error={error} />
        <div className="form-actions">
          <Button
            type="button"
            secondary
            onClick={() => {
              setDraft(emptyScheduleFilters());
              setSearch("");
              setError("");
            }}
          >
            Clear all
          </Button>
          <Button type="submit">Apply Filters</Button>
        </div>
      </form>
    </Modal>
  );
}
