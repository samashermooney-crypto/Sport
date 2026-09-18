import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { Button, ErrorBox, Field, Loading, useData } from "./components";
type Team = {
  id: string;
  name: string;
  program_name: string;
  can_edit_name: boolean;
  can_view_roster: boolean;
};
export function MemberTeams({ org }: { org: string }) {
  const data = useData<Team[]>(`/member/${org}/teams`, []);
  const [editing, setEditing] = useState<Team | null>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (data.loading) return <Loading />;
  return (
    <>
      <h1>My teams</h1>
      <ErrorBox error={error || data.error} />
      {!data.data.length && <p>You are not currently assigned to a team.</p>}
      {data.data.map((team) => (
        <section key={team.id}>
          <h2>{team.name}</h2>
          <p>{team.program_name}</p>
          {team.can_view_roster && <Link className="button secondary" to={`/site/${org}/teams/${team.id}`}>View roster</Link>}
          {team.can_edit_name && (
            <Button
              secondary
              disabled={busy}
              onClick={() => {
                setEditing(team);
                setName(team.name);
                setError("");
              }}
            >
              Edit team name
            </Button>
          )}
          {editing?.id === team.id && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  await api(`/member/${org}/teams/${team.id}/name`, {
                    method: "PUT",
                    body: JSON.stringify({ name, expected_name: editing.name }),
                  });
                  setEditing(null);
                  data.reload();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Team name" required>
                <input
                  value={name}
                  required
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button disabled={busy}>Save name</Button>{" "}
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </form>
          )}
        </section>
      ))}
    </>
  );
}
