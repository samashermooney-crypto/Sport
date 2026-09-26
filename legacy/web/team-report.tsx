import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import {
  Button,
  DataTable,
  ErrorBox,
  Field,
  PageTitle,
  useData,
} from "./components";
type SavedReport = {
  id: string;
  name: string;
  filters: {
    program_id: string;
    field_id: string;
    status: string;
    from: string;
    to: string;
  };
};
type Question = { id: string; name: string; options: string[] };
type Row = {
  id: string;
  name: string;
  counts: Record<string, number>;
  answered: number;
};
type Report = {
  range: { from: string; to: string };
  field: Question;
  options: string[];
  rows: Row[];
  totals: Record<string, number>;
  answered: number;
};
export function TeamPropertyReport() {
  const programs = useData<{ id: string; name: string }[]>("/programs", []);
  const saved = useData<SavedReport[]>("/reports/team-properties/saved", []);
  const [preset, setPreset] = useState<SavedReport | null>(null);
  const [program, setProgram] = useState("");
  return (
    <>
      <PageTitle title="Reports › Team Properties" />
      <main className="content-page">
        <p>
          Count player dropdown registration answers for each team in a program.
        </p>
        <ErrorBox error={programs.error || saved.error} />
        <Field label="My Saved Reports">
          <select
            value={preset?.id || ""}
            onChange={(e) => {
              const report =
                saved.data.find((r) => r.id === e.target.value) || null;
              setPreset(report);
              if (report) setProgram(report.filters.program_id);
            }}
          >
            <option value="">Select a saved report</option>
            {saved.data.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Program" required>
          <select
            value={program}
            onChange={(e) => {
              setProgram(e.target.value);
              setPreset(null);
            }}
          >
            <option value="">Select Program</option>
            {programs.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {program ? (
          <ReportForm
            key={program + (preset?.id || "")}
            program={program}
            preset={preset}
            onSaved={saved.reload}
          />
        ) : (
          <p>Please choose a program and a registration field to filter by.</p>
        )}
      </main>
    </>
  );
}
function ReportForm({
  program,
  preset,
  onSaved,
}: {
  program: string;
  preset: SavedReport | null;
  onSaved: () => void;
}) {
  const limits = useData<{ min: string; max: string; default_from: string }>(
    "/reports/team-properties/date-limits",
    { min: "", max: "", default_from: "" },
  );
  const fields = useData<Question[]>(
    `/reports/team-properties/fields?program_id=${encodeURIComponent(program)}`,
    [],
  );
  const [field, setField] = useState(preset?.filters.field_id || ""),
    [status, setStatus] = useState(preset?.filters.status || ""),
    [from, setFrom] = useState(preset?.filters.from || ""),
    [to, setTo] = useState(preset?.filters.to || "");
  const [reportName, setReportName] = useState(""),
    [saveBusy, setSaveBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [result, setResult] = useState<Report | null>(null),
    [exportQuery, setExportQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <ErrorBox error={error || fields.error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setResult(null);
          const query = new URLSearchParams({
            program_id: program,
            field_id: field,
            status,
            from,
            to,
          }).toString();
          try {
            setResult(await api<Report>(`/reports/team-properties?${query}`));
            setExportQuery(query);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="First Registration Field" required>
            <select
              required
              value={field}
              onChange={(e) => setField(e.target.value)}
            >
              <option value="">Select First Registration Field</option>
              {fields.data.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Registration Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {["", "Confirmed", "Pending", "Wait List", "Canceled"].map(
                (s) => (
                  <option key={s} value={s}>
                    {s || "Any"}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="From">
            <input
              type="date"
              value={from}
              min={limits.data.min}
              max={to || limits.data.max}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={to}
              min={from || limits.data.min}
              max={limits.data.max}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        <p>
          Select a dropdown question such as uniform size. Counts include only
          players assigned to a team; dates use the organization’s time zone.
          Select dates within the past three years, up to one year per report.
          Leaving both dates blank uses the past year.
        </p>
        <Button disabled={busy || fields.loading}>
          {busy ? "Running…" : "Run Report"}
        </Button>
      </form>
      {result && (
        <section className="team-property-results">
          <h2>{result.field.name}</h2>
          {notice && <p role="status">{notice}</p>}
          <form
            className="team-property-save"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaveBusy(true);
              setNotice("");
              setError("");
              try {
                await api("/reports/team-properties/saved", {
                  method: "POST",
                  body: JSON.stringify({
                    name: reportName,
                    filters: {
                      ...Object.fromEntries(new URLSearchParams(exportQuery)),
                      ...result.range,
                    },
                  }),
                });
                setNotice("Report saved.");
                setReportName("");
                onSaved();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaveBusy(false);
              }
            }}
          >
            <Field label="Report name" required>
              <input
                required
                maxLength={100}
                value={reportName}
                onChange={(e) => setReportName(e.target.value)}
              />
            </Field>
            <Button disabled={saveBusy}>
              {saveBusy ? "Saving…" : "Save Report"}
            </Button>
          </form>
          <p>
            {result.range.from} – {result.range.to}
          </p>
          <a className="team-property-export" href={`/api/reports/team-properties.csv?${exportQuery}`}>
            Export to CSV
          </a>
          <DataTable
            rows={result.rows}
            columns={[
              {
                key: "name",
                label: "Team",
                className: "team-property-name",
                render: (r) => <Link to={`/teams/${r.id}`}>{r.name}</Link>,
              },
              ...result.options.map((option) => ({
                key: `option:${option}`,
                label: option,
                render: (r: Row) => r.counts[option] || 0,
              })),
              { key: "answered", label: "Total" },
            ]}
          />
          <p>Total: {result.answered} answers</p>
        </section>
      )}
    </>
  );
}
