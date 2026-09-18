import { useState } from "react";
import { api } from "./api";
import { Button, ErrorBox, Loading, useData } from "./components";
export type CaptainPermissions = {
  edit_name: boolean;
  invite_players: boolean;
  accept_registrations: boolean;
  add_players: boolean;
};
export const captainLabels: [keyof CaptainPermissions, string][] = [
  ["edit_name", "Captain is permitted to edit team name."],
  ["invite_players", "Captain is permitted to invite players."],
  ["accept_registrations", "Set team to accept player registrations directly."],
  ["add_players", "Captain can manually add players to team."],
];
export function CaptainFields({
  value,
  change,
  disabled = false,
}: {
  value: CaptainPermissions;
  change: (v: CaptainPermissions) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {captainLabels.filter(([key]) => key === "edit_name").map(([key, label]) => (
        <label className="checkbox-line" key={key}>
          <input
            type="checkbox"
            checked={!!value[key]}
            disabled={disabled || key !== "edit_name"}
            onChange={(e) => change({ ...value, [key]: e.target.checked })}
          />
          {label}
        </label>
      ))}
      <p>
        Administrators manage player enrollment and roster changes. Captains can
        edit their team name when this permission is enabled.
      </p>
    </>
  );
}
export type CaptainConfiguration = {
  version: number;
  detached: boolean;
  permissions: CaptainPermissions;
  inherited: CaptainPermissions;
};
export function TeamCaptainSettings({ teamId }: { teamId: string }) {
  const data = useData<CaptainConfiguration | null>(
    `/teams/${teamId}/captain-permissions`,
    null,
  );
  const [draft, setDraft] = useState<CaptainConfiguration | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const current = draft || data.data;
  if (data.loading) return <Loading />;
  if (!current) return <ErrorBox error={data.error} />;
  return (
    <form
      className="options-section"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          setDraft(
            await api<CaptainConfiguration>(`/teams/${teamId}/captain-permissions`, {
              method: "PUT",
              body: JSON.stringify(current),
            }),
          );
          setSaved(true);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Captain Settings</h3>
      <ErrorBox error={error || data.error} />
      <CaptainFields
        value={current.permissions}
        disabled={!current.detached || busy}
        change={(permissions) => {
          setDraft({ ...current, permissions });
          setSaved(false);
        }}
      />
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={current.detached}
          disabled={busy}
          onChange={(e) => {
            setDraft({
              ...current,
              detached: e.target.checked,
              permissions: e.target.checked
                ? current.permissions
                : current.inherited,
            });
            setSaved(false);
          }}
        />
        Detach Captain Settings, so that changes on the program level don't
        affect this team anymore
      </label>
      <Button disabled={busy}>
        {busy ? "Saving…" : "Save Captain Settings"}
      </Button>
      {saved && <p role="status">Captain settings saved.</p>}
    </form>
  );
}
