import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, csv as downloadCsv } from "./api";
import { Button, PageTitle } from "./components";

type Preview = {
  ready: boolean; timezone: string; row_count: number; issue_count: number;
  issues: { line: number; column: string; message: string }[];
  mappings: { key: string; kind: string; name: string; selected_id: string | null; options: { id: string; name: string }[] }[];
  rows: { line: number; title: string; program_name: string; home_team_name: string; away_team_name: string; start_date: string; start_time: string; end_date: string; end_time: string | null; location_name: string; sub_location_name: string }[];
};
export function ScheduleImport() {
  const { id } = useParams();
  const back = id ? `/programs/${id}/schedule` : "/schedule";
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [published, setPublished] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [crossProgram, setCrossProgram] = useState(false);
  async function validate() {
    setBusy(true); setError(""); setDirty(true);
    try {
      if (!file) throw new Error("Choose a CSV file.");
      if (file.size > 2 * 1024 * 1024) throw new Error("The CSV file must be 2 MB or smaller.");
      const content = text || await file.text();
      const next = await api<Preview>("/schedule/import/preview", { method: "POST", body: JSON.stringify({ csv: content, program_id: id, cross_program: crossProgram, mappings }) });
      setText(content); setPreview(next); setDirty(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function accept() {
    setBusy(true); setAttempted(true); setError("");
    try { setResult(await api("/schedule/import/accept", { method: "POST", body: JSON.stringify({ csv: text, program_id: id, cross_program: crossProgram, mappings, published, request_key: key }) })); }
    catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.details.import_not_saved === true) {
        setAttempted(false); setDirty(true); setKey(crypto.randomUUID());
      }
    }
    finally { setBusy(false); }
  }
  return <><PageTitle title="Import Schedule" /><main className="content-page schedule-import">
    <Link to={back}>Back to schedule</Link>
    {result ? <section role="status"><h2>Import complete</h2><p>{result.count} {result.count === 1 ? "activity" : "activities"} imported {published ? "and published" : "as unpublished"}.</p><Link to={back}>View schedule</Link></section> : <>
      <h2>{preview ? "Map and review activities" : "Upload CSV file"}</h2>
      <p>Upload a game or event schedule. Dates use MM/DD/YYYY and times use 24-hour HH:MM. Teams and locations must already exist.</p>
      <div className="schedule-import-actions">
        <Button secondary type="button" onClick={() => downloadCsv("game-schedule-template", ["SUB_PROGRAM","HOME_TEAM","AWAY_TEAM","DATE","START_TIME","END_TIME","LOCATION","SUB_LOCATION","TYPE","NOTES"], [])}>Game template</Button>
        <Button secondary type="button" onClick={() => downloadCsv("event-schedule-template", ["SUB_PROGRAM","NAME","TYPE","START_DATE","START_TIME","END_DATE","END_TIME","TEAM","LOCATION","SUB_LOCATION","LOCATION_NOTE","DESCRIPTION"], [])}>Event template</Button>
      </div>
      <label>CSV file (maximum 2 MB)<input type="file" accept=".csv,text/csv" disabled={busy || attempted} onChange={(e) => { setFile(e.target.files?.[0] || null); setText(""); setPreview(null); setMappings({}); setError(""); setKey(crypto.randomUUID()); }} /></label>
      <label><input type="checkbox" checked={crossProgram} disabled={busy || attempted} onChange={(e) => { setCrossProgram(e.target.checked); setMappings({}); setDirty(true); }} /> Include teams from other programs</label>
      {error && <p role="alert" className="error">{error}</p>}
      {!attempted && <Button type="button" disabled={busy || !file} onClick={validate}>{busy ? "Validating…" : preview ? "Validate mappings" : "Upload & Validate"}</Button>}
      {preview && <>
        <p>{preview.row_count} {preview.row_count === 1 ? "activity" : "activities"} · Timezone: {preview.timezone}</p>
        <div className="schedule-import-mappings">{preview.mappings.map((mapping) => <label key={mapping.key}>{mapping.kind}: {mapping.name || "Unspecified"}<select disabled={busy || attempted} value={mappings[mapping.key] ?? mapping.selected_id ?? ""} onChange={(e) => { const next = { ...mappings }; if (e.target.value) next[mapping.key] = e.target.value; else delete next[mapping.key]; setMappings(next); setDirty(true); }}><option value="">Choose a match</option>{mapping.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}</div>
        {!!preview.issue_count && <section aria-label="Import issues"><h3>{preview.issue_count} issues to resolve</h3><ul>{preview.issues.map((issue, i) => <li key={i}>Line {issue.line}{issue.column ? `, ${issue.column}` : ""}: {issue.message}</li>)}</ul>{preview.issue_count > preview.issues.length && <p>Showing the first {preview.issues.length} issues. Correct these and validate again.</p>}</section>}
        {dirty && <p role="status">Validate your changed mappings before accepting.</p>}
        <div className="schedule-import-table"><table><thead><tr><th>CSV line</th><th>Program</th><th>Activity</th><th>Teams</th><th>Start</th><th>End</th><th>Location</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.line}><td>{row.line}</td><td>{row.program_name}</td><td>{row.title}</td><td>{[row.home_team_name, row.away_team_name].filter(Boolean).join(" / ") || "—"}</td><td>{row.start_date} {row.start_time}</td><td>{row.end_time ? `${row.end_date} ${row.end_time}` : "TBD"}</td><td>{[row.location_name, row.sub_location_name].filter(Boolean).join(" / ") || "—"}</td></tr>)}</tbody></table></div>
        <label><input type="checkbox" checked={published} disabled={busy || attempted} onChange={(e) => setPublished(e.target.checked)} /> Publish imported activities</label>
        <p>No activities are created until you accept. If any activity fails validation or conflicts, the entire import is rejected.</p>
        <Button type="button" disabled={busy || dirty || !preview.ready} onClick={accept}>{busy ? "Importing…" : attempted ? "Retry same import" : `Accept ${preview.row_count} ${preview.row_count === 1 ? "activity" : "activities"}`}</Button>
        {attempted && error && <p>The submitted file and options are locked so a retry cannot create duplicates. Resolve any reported schedule conflict, then retry this import.</p>}
      </>}
    </>}
  </main></>;
}
