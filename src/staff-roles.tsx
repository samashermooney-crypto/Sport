import { useState } from "react";
import { api } from "./api";
import {
  Button,
  Check,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
  useData,
} from "./components";
export const rolePermissions = [
  ["can_register", "Can register themself"],
  ["can_join_team", "Can join an existing team"],
  ["can_create_team", "Can create a team"],
  ["can_invite_players", "Can invite players"],
  ["can_manage_fields", "Can manage staff-managed registration fields"],
  ["can_submit_roster", "Can submit roster"],
  ["can_invite_staff", "Can invite additional staff"],
  ["can_be_invited", "Can be invited as additional staff"],
  ["can_check_in", "Can check in attendees"],
  ["can_edit_scores", "Can add and edit scores"],
  ["can_evaluate", "Can evaluate players"],
] as const;
const supportedRolePermissions = rolePermissions.filter(([key]) => ["can_register", "can_check_in"].includes(key));
type Permission = (typeof rolePermissions)[number][0];
export type StaffRole = {
  id: string;
  name: string;
  max_program: number | null;
  max_team: number | null;
} & Record<Permission, boolean>;
export type StaffRoleSettings = { version: number; roles: StaffRole[] };
export function StaffRoles() {
  const { data, loading, error, reload } = useData<StaffRoleSettings>(
    "/settings/staff-roles",
    { version: 1, roles: [] },
  );
  const [editing, setEditing] = useState<StaffRole | null>(null),
    [removing, setRemoving] = useState<StaffRole | null>(null),
    [failure, setFailure] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(roles: StaffRole[]) {
    setBusy(true);
    setFailure("");
    setNotice("");
    try {
      await api("/settings/staff-roles", {
        method: "PUT",
        body: JSON.stringify({ ...data, roles }),
      });
      setEditing(null);
      setRemoving(null);
      setNotice("Staff roles saved.");
      reload();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="Staff Roles Settings" />
      <main className="content-page staff-role-settings">
        <ErrorBox error={error} />
        {notice && <p role="status">{notice}</p>}
        <Button
          type="button"
          onClick={() => {
            setFailure("");
            setEditing({
              id: crypto.randomUUID(),
              name: "",
              max_program: null,
              max_team: null,
              ...Object.fromEntries(
                rolePermissions.map(([key]) => [key, false]),
              ),
            } as StaffRole);
          }}
        >
          + Add New Role
        </Button>
        {loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={data.roles}
            columns={[
              { key: "name", label: "Role", className: "staff-role-name", render: (r) => r.name },
              ...supportedRolePermissions.map(([key, label]) => ({
                key,
                label,
                className: "staff-permission",
                render: (r: StaffRole) => (r[key] ? "✓" : "—"),
              })),
              {
                key: "max_program",
                label: "Max per program",
                render: (r) => r.max_program ?? "unlimited",
              },
              {
                key: "max_team",
                label: "Max per team",
                render: (r) => r.max_team ?? "unlimited",
              },
              {
                key: "actions",
                label: "Actions",
                className: "staff-role-actions",
                render: (r) => (
                  <>
                    <button
                      className="text-button"
                      onClick={() => {
                        setFailure("");
                        setEditing(r);
                      }}
                    >
                      Edit {r.name}
                    </button>{" "}
                    <button
                      className="text-button"
                      onClick={() => {
                        setFailure("");
                        setRemoving(r);
                      }}
                    >
                      Delete {r.name}
                    </button>
                  </>
                ),
              },
            ]}
          />
        )}
        {editing && (
          <RoleEditor
            role={editing}
            busy={busy}
            error={failure}
            close={() => setEditing(null)}
            save={(role) =>
              save(
                data.roles.some((r) => r.id === role.id)
                  ? data.roles.map((r) => (r.id === role.id ? role : r))
                  : [...data.roles, role],
              )
            }
          />
        )}
        {removing && (
          <Modal
            title={`Delete ${removing.name}?`}
            onClose={() => setRemoving(null)}
          >
            <div className="modal-body">
              <ErrorBox error={failure} />
              <p>
                Roles used by registrations, assignments, or form rules must be
                retained.
              </p>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  save(data.roles.filter((r) => r.id !== removing.id))
                }
              >
                Delete role
              </Button>{" "}
              <Button type="button" secondary onClick={() => setRemoving(null)}>
                Cancel
              </Button>
            </div>
          </Modal>
        )}
      </main>
    </>
  );
}
function RoleEditor({
  role,
  busy,
  error,
  close,
  save,
}: {
  role: StaffRole;
  busy: boolean;
  error: string;
  close: () => void;
  save: (role: StaffRole) => void;
}) {
  const [form, setForm] = useState(role);
  return (
    <Modal
      title={role.name ? `Edit ${role.name}` : "Add New Role"}
      onClose={close}
    >
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          save(form);
        }}
      >
        <ErrorBox error={error} />
        <Field label="Staff role title" required>
          <input
            required
            maxLength={80}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <p>Member self-registration and attendance check-in are supported. Other staff actions are managed through the administrator console.</p>
        {supportedRolePermissions.map(([key, label]) => (
          <Check
            key={key}
            checked={form[key]}
            disabled={
              ["can_join_team", "can_create_team"].includes(key) &&
              !form.can_register
            }
            onChange={(e) =>
              setForm({
                ...form,
                [key]: e.target.checked,
                ...(key === "can_register" && !e.target.checked
                  ? { can_join_team: false, can_create_team: false }
                  : {}),
              })
            }
          >
            {label}
          </Check>
        ))}
        <div className="form-grid">
          {(
            [
              ["max_program", "Max per program"],
              ["max_team", "Max per team"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label} hint="Leave blank for unlimited.">
              <input
                type="number"
                min={1}
                step={1}
                value={form[key] ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    [key]: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </Field>
          ))}
        </div>
        <div className="form-actions">
          <Button secondary type="button" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>{busy ? "Saving…" : "Save role"}</Button>
        </div>
      </form>
    </Modal>
  );
}
