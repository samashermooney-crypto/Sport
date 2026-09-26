import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, csv } from "./api";
import {
  Button,
  Check,
  DataTable,
  Empty,
  ErrorBox,
  ExportButton,
  Field,
  Loading,
  PageTitle,
  Select,
  Tabs,
  useData,
} from "./components";
import { ProgramNav } from "./programs";

const rankings = [
  "Standings Point Differential",
  "Winning Percentage",
  "Cumulative Match Game Winning Percentage",
];
const tiebreakers = [
  "More Points Scored",
  "More Wins",
  "Fewer Points Scored Against",
  "More Standings Points For",
  "Higher Points Scored Differential",
  "Head to Head",
  "More Match Game Wins",
  "Fewer Match Game Losses",
  "Higher Match Game Winning Percentage",
];
const fields = {
  played: ["GP", "Games Played"],
  wins: ["W", "Wins"],
  losses: ["L", "Losses"],
  ties: ["T", "Ties"],
  percentage: ["PCT", "Winning Percentage"],
  scored: ["PS", "Points Scored"],
  against: ["PSA", "Points Scored Against"],
  differential: ["PSD", "Points Scored Differential"],
  forfeits: ["DNP", "Forfeits"],
  points_for: ["PF", "Standings Points For"],
  points_against: ["PA", "Standings Points Against"],
  points_differential: ["+/−", "Standings Point Differential"],
  match_wins: ["GW", "Match Game Wins"],
  match_losses: ["GL", "Match Game Losses"],
  match_percentage: ["GPCT", "Match Game Winning Percentage"],
};
type Stat = keyof typeof fields;
const pointLabels = {
  win_points: "Win",
  overtime_win_points: "Overtime Win",
  loss_points: "Loss",
  overtime_loss_points: "Overtime Loss",
  tie_points: "Tie",
  forfeit_deduction: "Forfeit Deduction",
};
export type StandingsRules = Record<keyof typeof pointLabels, number> & {
  version: number;
  scoring_method: string;
  ranking: string;
  percentage_format: string;
  tiebreakers: string[];
  fields: Stat[];
  exclude_tournament: boolean;
  exclude_playoff: boolean;
  exclude_championship: boolean;
  include_cross_program: boolean;
  rank_by_division: boolean;
  points_based_percentage: boolean;
  calendar_week_start: number;
};
type Standing = Record<Stat, number> & {
  id: string;
  name: string;
  division: string;
  program_id: string;
  rank: number;
  tied: boolean;
};
type StandingData = {
  manualRanking?: {enabled: boolean; ranks: Record<string,number>; version: number};
  note: {text: string; version: number};
  program: { id: string; name: string };
  rules: StandingsRules;
  groups: { division: string; rows: Standing[] }[];
  games_counted: number;
};
const preferences = {
  exclude_tournament: "Exclude tournament games from standings",
  exclude_playoff: "Exclude playoff, quarterfinal and semifinal games",
  exclude_championship: "Exclude championship and final games",
  include_cross_program: "Include cross-program games",
  rank_by_division: "Rank teams within each division",
  points_based_percentage:
    "Calculate winning percentage using standings points",
};

export function StandingsSettings() {
  const { id } = useParams();
  const { data, loading, error, reload } = useData<StandingsRules | null>(
    `/standings-rules/${id || "site"}`,
    null,
  );
  return (
    <>
      <PageTitle title="Schedules & Standings" />
      {id && <ProgramNav id={id} active="Settings" />}
      <main className="content-page">
        <ErrorBox error={error} />
        {loading ? (
          <Loading />
        ) : data ? (
          <RulesEditor key={id || "site"} initial={data} programId={id} />
        ) : (
          <Button secondary onClick={reload}>
            Reload settings
          </Button>
        )}
      </main>
    </>
  );
}
function RulesEditor({
  initial,
  programId,
}: {
  initial: StandingsRules;
  programId?: string;
}) {
  const [form, setForm] = useState(initial),
    [tab, setTab] = useState("Standings Rules"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  function change(patch: Partial<StandingsRules>) {
    setForm({ ...form, ...patch });
    setSaved(false);
  }
  return (
    <>
      <Tabs
        items={["Standings Rules", "Schedule Settings"]}
        value={tab}
        onChange={setTab}
      />
      {!programId && (
        <p className="info-box">
          Default rules for new programs. To update a running season, edit that
          program’s standings rules.
        </p>
      )}
      <form
        className="website-columns standings-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const value = await api<StandingsRules>(
              `/standings-rules/${programId || "site"}`,
              { method: "PUT", body: JSON.stringify(form) },
            );
            setForm(value);
            setSaved(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <section>
          <ErrorBox error={error} />
          {saved && (
            <p className="success-box" role="status">
              Settings saved.
            </p>
          )}
          {tab === "Standings Rules" ? (
            <>
              <h2>Scoring Method</h2>
              <Field label="Scoring Method">
                <Select
                  value={form.scoring_method}
                  options={["Game", "Match"]}
                  onChange={(e) => change({ scoring_method: e.target.value })}
                />
              </Field>
              <h2>Rankings</h2>
              <Field label="Rank teams by">
                <Select
                  value={form.ranking}
                  options={rankings}
                  onChange={(e) => change({ ranking: e.target.value })}
                />
              </Field>
              <Field label="Winning Percentage Display">
                <Select
                  value={form.percentage_format}
                  options={["100.00%", "1.000"]}
                  onChange={(e) =>
                    change({ percentage_format: e.target.value })
                  }
                />
              </Field>
              <h2>Point Values</h2>
              <div className="form-grid standings-points">
                {(Object.keys(pointLabels) as (keyof typeof pointLabels)[]).map(
                  (key) => (
                    <Field key={key} label={pointLabels[key]}>
                      <input
                        required
                        min={0}
                        max={10000}
                        step="any"
                        type="number"
                        value={form[key]}
                        onChange={(e) =>
                          change({ [key]: e.target.valueAsNumber })
                        }
                      />
                    </Field>
                  ),
                )}
              </div>
              <h2>Tiebreaker Rules</h2>
              {["Primary", "Secondary", "Fallback"].map((label, i) => (
                <Field key={label} label={label}>
                  <Select
                    options={tiebreakers}
                    value={form.tiebreakers[i]}
                    onChange={(e) =>
                      change({
                        tiebreakers: form.tiebreakers.map((v, n) =>
                          n === i ? e.target.value : v,
                        ),
                      })
                    }
                  />
                </Field>
              ))}
              <h2>Preferences</h2>
              {(Object.keys(preferences) as (keyof typeof preferences)[]).map(
                (key) => (
                  <Check
                    key={key}
                    checked={form[key]}
                    onChange={(e) => change({ [key]: e.target.checked })}
                  >
                    {preferences[key]}
                  </Check>
                ),
              )}
              <h2>Fields to Display</h2>
              <div className="standings-field-options">
                {(Object.keys(fields) as Stat[]).map((key) => (
                  <Check
                    key={key}
                    checked={form.fields.includes(key)}
                    onChange={(e) =>
                      change({
                        fields: e.target.checked
                          ? [...form.fields, key]
                          : form.fields.filter((f) => f !== key),
                      })
                    }
                  >
                    {fields[key][1]}
                  </Check>
                ))}
              </div>
            </>
          ) : (
            <>
              <h2>Schedule Settings</h2>
              <Field label="Calendar Week Starts On">
                <Select
                  value={String(form.calendar_week_start)}
                  options={[
                    { value: "0", label: "Sunday" },
                    { value: "1", label: "Monday" },
                  ]}
                  onChange={(e) =>
                    change({ calendar_week_start: +e.target.value })
                  }
                />
              </Field>
              <p className="muted">
                External team management, captain scorekeeper permissions and
                print-logo settings are not available yet.
              </p>
            </>
          )}
          <div className="form-actions start">
            <Button disabled={busy || !form.fields.length}>
              {busy ? "Saving…" : "Save Preferences"}
            </Button>
            <Link
              className="button secondary"
              to={programId ? `/programs/${programId}/standings` : "/"}
            >
              Cancel
            </Link>
          </div>
        </section>
        <aside className="website-help">
          <h3>Standings points and game scores</h3>
          <p>
            Game scores determine the result. Point values determine the
            standings points awarded for that result. Forfeit deductions are
            tracked separately.
          </p>
          <h3>Game and match scoring</h3>
          <p>
            Game scoring uses the final points scored. Match scoring uses the
            number of individual games won within the match.
          </p>
          <h3>Which results count?</h3>
          <p>
            Only completed games with results count. Exclusion rules and the
            per-team exclusions in score entry are respected. The public website
            includes published games only.
          </p>
          <h3>Winning percentage</h3>
          <p>
            Standard percentage counts a tie as half a win. Points-based
            percentage divides net standings points by games played times points
            for a win.
          </p>
        </aside>
      </form>
    </>
  );
}
const formatStat = (row: Standing, key: Stat, rules: StandingsRules) =>
  key === "percentage" || key === "match_percentage"
    ? rules.percentage_format === "1.000"
      ? row[key].toFixed(3)
      : `${(row[key] * 100).toFixed(2)}%`
    : Number(row[key].toFixed(3)).toString();
function StandingsTable({
  data,
  publicView = false,
  rankInput,
}: {
  data: StandingData;
  publicView?: boolean;
  rankInput?: (row: Standing) => React.ReactNode;
}) {
  return (
    <>
      {data.note?.text && <p className="standings-note">{data.note.text}</p>}
      {!data.groups.some((g) => g.rows.length) ? (
        <Empty>No teams have been added to this program.</Empty>
      ) : (
        data.groups.map((group, i) => (
          <section key={group.division || i} className="standings-group">
            {data.rules.rank_by_division && (
              <h3>{group.division || "Unassigned division"}</h3>
            )}
            <DataTable
              rows={group.rows}
              columns={[
                {
                  key: "rank",
                  label: "Rank",
                  render: (r) => rankInput ? rankInput(r) : `${r.rank}${r.tied ? "=" : ""}`,
                },
                {
                  key: "name",
                  label: "Team",
                  className: "standings-team-name",
                  render: (r) =>
                    publicView ? (
                      r.name
                    ) : (
                      <Link to={`/teams/${r.id}`}>{r.name}</Link>
                    ),
                },
                ...data.rules.fields.map((key) => ({
                  key,
                  label: fields[key][0],
                  render: (r: Standing) => formatStat(r, key, data.rules),
                })),
              ]}
            />
          </section>
        ))
      )}
      <dl className="standings-legend">
        {data.rules.fields.map((key) => (
          <div key={key}>
            <dt>{fields[key][0]}</dt>
            <dd>{fields[key][1]}</dd>
          </div>
        ))}
      </dl>
      <details className="standings-rule-summary">
        <summary>Tiebreaker Rules</summary>
        <p>{data.manualRanking?.enabled ? "Manual rankings are enabled." : `Ranked by ${data.rules.ranking.toLowerCase()}.`}</p>
        <ol>
          {data.rules.tiebreakers.map((rule, i) => (
            <li key={i}>{rule}</li>
          ))}
        </ol>
        <p>
          Teams still tied after all rules share a rank. Head-to-head compares
          tied teams with balanced completed matchups.
        </p>
      </details>
    </>
  );
}
function StandingsNoteEditor({programId, note, reload}: {programId: string; note: StandingData["note"]; reload: () => void}) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(note.text), [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!editing) return <Button secondary onClick={() => setEditing(true)}>{note.text ? "Edit standings note" : "Add a standings note…"}</Button>;
  return <form onSubmit={async e => {e.preventDefault();setBusy(true);setError("");try {await api(`/programs/${programId}/standings/note`, {method:"PUT",body:JSON.stringify({text,version:note.version})});setEditing(false);reload();} catch(e) {setError((e as Error).message);} finally {setBusy(false);}}}>
    <ErrorBox error={error}/><Field label="Standings note"><textarea aria-label="Standings note" rows={4} maxLength={10000} value={text} onChange={e=>setText(e.target.value)}/></Field>
    <div className="form-actions"><Button disabled={busy}>Save note</Button><Button type="button" secondary disabled={busy} onClick={()=>{setText(note.text);setEditing(false);setError("");}}>Cancel</Button></div>
  </form>;
}
function RankingEditor({data,reload}: {data: StandingData;reload:()=>void}) {
 const initial=data.manualRanking || {enabled:false,ranks:{},version:1};
 const [enabled,setEnabled]=useState(initial.enabled),[ranks,setRanks]=useState<Record<string,number>>(Object.fromEntries(data.groups.flatMap(g=>g.rows.map(r=>[r.id,initial.ranks[r.id] ?? r.rank])))),[busy,setBusy]=useState(false),[error,setError]=useState("");
 return <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError("");try {await api(`/programs/${data.program.id}/standings/ranking`,{method:"PUT",body:JSON.stringify({enabled,ranks,version:initial.version})});reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
 <ErrorBox error={error}/><Check checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}>Manually Update Ranking</Check>
 <StandingsTable data={data} rankInput={r=><input aria-label={`Rank for ${r.name}`} type="number" min={0} max={100000} step={1} required disabled={!enabled||busy} value={enabled ? (ranks[r.id] ?? 0) : r.rank} onChange={e=>setRanks({...ranks,[r.id]:Number(e.target.value)})} style={{width:70}}/>}/>
 <Button disabled={busy}>Update Ranking</Button><p className="muted">Saving manual rankings disables automatic ranking. Turn this off and update to restore automatic ranking.</p>
 </form>;
}
export function Standings() {
  const { id } = useParams();
  const { data, loading, error, reload } = useData<StandingData | null>(
    `/programs/${id}/standings`,
    null,
  );
  return (
    <>
      <PageTitle
        title={data ? `${data.program.name} › Standings` : "Standings"}
      />
      {id && <ProgramNav id={id} active="Standings" />}
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="page-tools">
          <div className="inline">
            <Link className="button" to={`/programs/${id}/standings/rules`}>
              Edit Standings Rules
            </Link>
            <Button secondary onClick={reload}>
              Refresh
            </Button>
          </div>
          <ExportButton
            disabled={!data || loading || !!error}
            onClick={() => {
              if (data)
                csv(
                  "standings",
                  [
                    "Rank",
                    "Division",
                    "Team",
                    ...data.rules.fields.map((f) => fields[f][1]),
                  ],
                  data.groups.flatMap((g) =>
                    g.rows.map((r) => [
                      r.rank,
                      g.division,
                      r.name,
                      ...data.rules.fields.map((f) =>
                        formatStat(r, f, data.rules),
                      ),
                    ]),
                  ),
                );
            }}
          />
        </div>
        {loading ? (
          <Loading />
        ) : (
          data && !error && (
            <>
              <p className="muted">
                {data.games_counted} completed games included. Unpublished
                results appear here; only published results appear on the
                website.
              </p>
              <StandingsNoteEditor key={`${id}:${data.note?.version || 1}`} programId={id!} note={data.note || {text:"",version:1}} reload={reload}/>
              <RankingEditor key={`${id}:${data.manualRanking?.version || 1}`} data={data} reload={reload}/>
            </>
          )
        )}
      </main>
    </>
  );
}
export function PublicStandings({
  org,
  programId,
}: {
  org: string;
  programId: string;
}) {
  const { data, loading, error } = useData<StandingData | null>(
    `/public/sites/${org}/programs/${programId}/standings`,
    null,
  );
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || (!data.note?.text && !data.groups.some((g) => g.rows.length))) return null;
  return (
    <section className="public-standings">
      <h2>Standings</h2>
      <StandingsTable data={data} publicView />
    </section>
  );
}
