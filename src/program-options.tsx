import { CaptainFields, type CaptainPermissions } from "./team-permissions";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "./api";
import {
  Button,
  Check,
  DateInput,
  ErrorBox,
  Field,
  Loading,
  PageTitle,
  Select,
  useData,
} from "./components";
import { ProgramNav } from "./programs";
import { RichText } from "./rich-text";
import type { Program } from "./types";
type TeamCompletion = {
  min_players: number;
  min_male: number;
  min_female: number;
  payment: string;
};
type Rules = {
  team_completion?: Partial<TeamCompletion>;
  captain_permissions: CaptainPermissions;
  use_site_defaults: boolean;
  enable_payment_plans: boolean;
  allow_free_agents: boolean;
  allow_team_players: boolean;
  allow_staff: boolean;
  min_age: number | null;
  max_age: number | null;
  age_as_of: string;
  capacity_includes_pending: boolean;
  male_capacity: number | null;
  female_capacity: number | null;
  require_paid_invoices: boolean;
  allow_discounts: boolean;
  require_waiver: boolean;
  early_fee_cents: number | null;
  early_ends: string;
  late_fee_cents: number | null;
  late_starts: string;
  deadline_mode: string;
  deadline_date: string;
  success_message: string;
  skipped_message: string;
  abandoned_message: string;
  fee_cents?: number;
  capacity?: number | null;
  waitlist?: boolean;
};
export function RegistrationOptions() {
  const { id } = useParams(),
    data = useData<Rules | null>(
      id ? "/programs/" + id + "/options" : "/settings/registration",
      null,
    ),
    programs = useData<Program[]>("/programs", []);
  if (data.loading) return <Loading />;
  return data.data ? (
    <OptionsForm
      key={id || "site"}
      initial={data.data}
      program={programs.data.find((p) => p.id === id)}
      programId={id}
    />
  ) : (
    <ErrorBox error={data.error} />
  );
}
function OptionsForm({
  initial,
  program,
  programId,
}: {
  initial: Rules;
  program?: Program;
  programId?: string;
}) {
  const [form, setForm] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const completion: TeamCompletion = {
    min_players: 0,
    min_male: 0,
    min_female: 0,
    payment: "None",
    ...form.team_completion,
  };
  const set = <K extends keyof Rules>(key: K, value: Rules[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const boolean = (key: keyof Rules, label: string) => (
    <Check
      checked={!!form[key]}
      onChange={(e) => set(key, e.target.checked as never)}
    >
      {label}
    </Check>
  );
  const capacity = (key: keyof Rules, label: string, min = 1) => (
    <Field label={label} hint="Leave blank for no limit">
      <input
        type="number"
        min={min}
        max={100000}
        value={
          form[key] === null || form[key] === undefined ? "" : String(form[key])
        }
        onChange={(e) =>
          set(
            key,
            (e.target.value === "" ? null : Number(e.target.value)) as never,
          )
        }
      />
    </Field>
  );
  const price = (
    key: "fee_cents" | "early_fee_cents" | "late_fee_cents",
    label: string,
  ) => (
    <Field label={label}>
      <div className="currency-input">
        <span>$</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={(form[key] || 0) / 100}
          onChange={(e) => set(key, Math.round(Number(e.target.value) * 100))}
        />
      </div>
    </Field>
  );
  return (
    <>
      <PageTitle
        title={programId ? "Registration Options" : "Registration Settings"}
        crumbs={
          programId
            ? [
                {
                  label: program?.name || "Program",
                  to: "/programs/" + programId,
                },
              ]
            : undefined
        }
      />
      {programId && <ProgramNav id={programId} active="Settings" />}
      {programId && (
        <p>
          <Link to={"/programs/" + programId + "/payment-plans"}>
            Payment Plans »
          </Link>
        </p>
      )}
      <RegistrationTabs programId={programId} active="Options" />
      <main className="content-page options-layout">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const saved = await api<Rules>(
                programId
                  ? "/programs/" + programId + "/options"
                  : "/settings/registration",
                { method: "PUT", body: JSON.stringify(form) },
              );
              setForm(saved);
              setSaved(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ErrorBox error={error} />
          {saved && (
            <div className="success-box" role="status">
              Registration settings saved.
            </div>
          )}
          {programId ? (
            <div className="notice">
              <p>
                These settings belong to this program. Site defaults are copied
                when a program is created; later default changes do not affect
                it.
              </p>
            </div>
          ) : (
            <p className="notice">
              Changing defaults applies to new programs. Existing programs keep
              their current settings.
            </p>
          )}
          {programId && (
            <section className="options-section">
              <h2>Registration Capacity & Pricing</h2>
              {price("fee_cents", "Standard Individual Fee")}
              <p className="hint">
                A $0 fee is free registration. Staff roles do not incur the
                player registration fee.
              </p>
              <div className="form-grid">
                {capacity("capacity", "Maximum players")}
              </div>
              {boolean(
                "waitlist",
                "Enable waiting list when capacity is reached",
              )}
            </section>
          )}
          <fieldset className="options-fieldset">
            <section className="options-section">
              <h2>General Options</h2>
              {boolean("allow_free_agents", "Allow Free Agent Registrations")}
              {boolean("allow_team_players", "Allow Team Player Registrations")}
              {boolean("allow_staff", "Allow Staff Registrations")}
              <h3>Captain Settings</h3>
              <CaptainFields
                value={
                  form.captain_permissions || {
                    edit_name: false,
                    invite_players: false,
                    accept_registrations: false,
                    add_players: false,
                  }
                }
                change={(captain_permissions) =>
                  setForm({ ...form, captain_permissions })
                }
              />
              <h3>Age Requirements</h3>
              <div className="form-grid">
                {capacity("min_age", "Minimum age", 0)}
                {capacity("max_age", "Maximum age", 0)}
                <Field
                  label="Age effective date"
                  hint="Defaults to the program start date"
                >
                  <DateInput
                    value={form.age_as_of}
                    onChange={(e) => set("age_as_of", e.target.value)}
                  />
                </Field>
              </div>
              <h3>Team Completion</h3>
              <p>
                Teams are complete when all selected roster and payment
                requirements are met. Zero roster minimums and no payment
                requirement allow teams to complete immediately.
              </p>
              <div className="form-grid">
                {(
                  [
                    ["min_players", "Minimum team players"],
                    ["min_male", "Minimum male team players"],
                    ["min_female", "Minimum female team players"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      type="number"
                      min={0}
                      max={100000}
                      required
                      value={completion[key]}
                      onChange={(e) =>
                        set("team_completion", {
                          ...completion,
                          [key]: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
              <Field label="Team payment requirement">
                <Select
                  value={completion.payment}
                  onChange={(e) =>
                    set("team_completion", {
                      ...completion,
                      payment: e.target.value,
                    })
                  }
                  options={[
                    { value: "None", label: "No payment requirement" },
                    { value: "Half", label: "At least half paid" },
                    { value: "Full", label: "Fully paid" },
                  ]}
                />
              </Field>
              <h3>Capacity Calculation</h3>
              {boolean(
                "capacity_includes_pending",
                "Include both reserved and pending registrations when calculating capacity",
              )}
              <div className="form-grid">
                {capacity("male_capacity", "Maximum male players")}
                {capacity("female_capacity", "Maximum female players")}
              </div>
              {boolean(
                "require_paid_invoices",
                "Require outstanding invoices to be paid before a new registration",
              )}
              {boolean(
                "require_waiver",
                "Require waiver acceptance before completing registration",
              )}
            </section>
            <section className="options-section">
              <h2>Payment Options</h2>
              {boolean("enable_payment_plans", "Enable payment plans for registration")}
              {boolean("allow_discounts", "Allow discount codes")}
              <h3>Early-Bird Pricing</h3>
              <Check
                checked={form.early_fee_cents !== null}
                onChange={(e) =>
                  set(
                    "early_fee_cents",
                    e.target.checked ? form.fee_cents || 0 : null,
                  )
                }
              >
                Enable early-bird pricing
              </Check>
              {form.early_fee_cents !== null && (
                <div className="form-grid">
                  {price("early_fee_cents", "Early-Bird Individual Fee")}
                  <Field label="Early-bird pricing ends">
                    <DateInput
                      required
                      value={form.early_ends}
                      onChange={(e) => set("early_ends", e.target.value)}
                    />
                  </Field>
                </div>
              )}
              <h3>Late Pricing</h3>
              <Check
                checked={form.late_fee_cents !== null}
                onChange={(e) =>
                  set(
                    "late_fee_cents",
                    e.target.checked ? form.fee_cents || 0 : null,
                  )
                }
              >
                Enable late registration pricing
              </Check>
              {form.late_fee_cents !== null && (
                <div className="form-grid">
                  {price("late_fee_cents", "Late Individual Fee")}
                  <Field label="Late pricing starts">
                    <DateInput
                      required
                      value={form.late_starts}
                      onChange={(e) => set("late_starts", e.target.value)}
                    />
                  </Field>
                </div>
              )}
              <h3>Payment Deadline</h3>
              <Field label="Invoice deadline">
                <Select
                  value={form.deadline_mode}
                  onChange={(e) => set("deadline_mode", e.target.value)}
                  options={[
                    "Activity start",
                    "During registration",
                    "Date",
                    "None",
                  ]}
                />
              </Field>
              {form.deadline_mode === "Date" && (
                <Field label="Deadline date">
                  <DateInput
                    required
                    value={form.deadline_date}
                    onChange={(e) => set("deadline_date", e.target.value)}
                  />
                </Field>
              )}
            </section>
            <section className="options-section">
              <h2>Registration Messages</h2>
              <h3>Successful Registration</h3>
              <RichText
                label="Successful registration message"
                value={form.success_message}
                onChange={(v) => set("success_message", v)}
                maxLength={10000}
              />
              <h3>Skipped Payment</h3>
              <RichText
                label="Skipped payment message"
                value={form.skipped_message}
                onChange={(v) => set("skipped_message", v)}
                maxLength={10000}
              />
              <h3>Abandoned Registration</h3>
              <RichText
                label="Abandoned registration message"
                value={form.abandoned_message}
                onChange={(v) => set("abandoned_message", v)}
                maxLength={10000}
              />
            </section>
          </fieldset>
          <div className="form-actions">
            <Link to={programId ? "/programs/" + programId : "/"}>Cancel</Link>
            <Button disabled={busy}>{busy ? "Saving…" : "Save Options"}</Button>
          </div>
        </form>
        <aside className="options-help">
          <h3>Registration Settings</h3>
          <p>
            Control who can join a program, registration limits, fees and
            payment deadlines.
          </p>
          {programId && (
            <Link to="/settings/registration">Edit site defaults</Link>
          )}
          <p>
            Age is calculated on the effective date. Pricing dates use the
            organization’s time zone.
          </p>
          <p>
            Changes affect new registrations. Existing invoices and
            registrations retain their original amounts.
          </p>
        </aside>
      </main>
    </>
  );
}
import { RegistrationTabs } from "./forms";
