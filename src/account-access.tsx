import { useCallback, useState } from "react";
import { api, shortDate } from "./api";
import {
  Button,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
  useData,
} from "./components";
import { DevelopmentPreview } from "./account-auth";

type Invitation = {
  id: string;
  email: string;
  name?: string;
  role?: string;
  status: string;
  expires_at: string;
  sent_at: string | null;
  delivery_error: string;
};
type ConsoleUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  revision: number;
};
type Delivery = { delivery?: string; development_link?: string };
const roles = ["owner", "admin", "manager", "reporter"];
const roleDescriptions: Record<string, string> = {
  owner:
    "Full access, including inviting administrators and managing their access.",
  admin: "Manage organization operations and member account invitations.",
  manager: "Manage day-to-day operations. Cannot manage account access.",
  reporter: "Read-only access to the administrator console.",
};
function RoleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Console role" hint={roleDescriptions[value]}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!roles.includes(value) && (
          <option value={value}>{value} (legacy)</option>
        )}
        {roles.map((role) => (
          <option key={role} value={role}>
            {role[0].toUpperCase() + role.slice(1)}
          </option>
        ))}
      </select>
    </Field>
  );
}
function InvitationList({
  invitations,
  busy,
  act,
}: {
  invitations: Invitation[];
  busy: boolean;
  act: (i: Invitation, action: "resend" | "revoke") => void;
}) {
  return (
    <div className="access-list">
      {invitations.length ? (
        invitations.map((invitation) => {
          const pending = invitation.status === "Pending";
          const expired =
            pending && Date.parse(invitation.expires_at) <= Date.now();
          return (
            <article className="access-row" key={invitation.id}>
              <div className="access-identity">
                <strong>{invitation.name || invitation.email}</strong>
                {invitation.name && <span>{invitation.email}</span>}
                <span>
                  {invitation.role ? invitation.role + " · " : ""}
                  {expired ? "Expired" : invitation.status}
                </span>
                {pending && (
                  <small>
                    {expired ? "Expired" : "Expires"}{" "}
                    {shortDate(invitation.expires_at)} ·{" "}
                    {invitation.delivery_error
                      ? "Email delivery failed"
                      : invitation.sent_at
                        ? "Email accepted for delivery"
                        : "Email not sent"}
                  </small>
                )}
                {invitation.delivery_error && (
                  <p>{invitation.delivery_error}</p>
                )}
              </div>
              {pending && (
                <div className="access-actions">
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => act(invitation, "resend")}
                  >
                    Resend
                  </Button>
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => act(invitation, "revoke")}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </article>
          );
        })
      ) : (
        <p>No invitations yet.</p>
      )}
    </div>
  );
}
export function ConsoleAccess({
  currentUser,
}: {
  currentUser: { id: string; role: string };
}) {
  if (currentUser.role !== "owner")
    return (
      <>
        <PageTitle title="Administrator access" />
        <p>Only an organization owner can manage administrator access.</p>
      </>
    );
  return <ConsoleAccessManager currentUserId={currentUser.id} />;
}
function ConsoleAccessManager({ currentUserId }: { currentUserId: string }) {
  const { data, loading, error, reload } = useData<{
    users: ConsoleUser[];
    invitations: Invitation[];
  }>("/admin-users", { users: [], invitations: [] });
  const [invite, setInvite] = useState(false),
    [editing, setEditing] = useState<ConsoleUser | null>(null);
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState("");
  const closeInvite = useCallback(() => setInvite(false), []),
    closeEdit = useCallback(() => setEditing(null), []);
  async function invitationAction(
    invitation: Invitation,
    action: "resend" | "revoke",
  ) {
    if (
      busy ||
      (action === "revoke" &&
        !window.confirm(
          `Revoke the invitation for ${invitation.email}? Its link will stop working.`,
        ))
    )
      return;
    setBusy(true);
    setActionError("");
    setMessage("");
    setPreview("");
    try {
      const result = await api<Delivery>(
        `/admin-users/invitations/${invitation.id}${action === "resend" ? "/resend" : ""}`,
        { method: action === "resend" ? "POST" : "DELETE" },
      );
      setMessage(
        action === "revoke"
          ? "Invitation revoked."
          : result.delivery === "sent"
            ? "Invitation email accepted for delivery."
            : "Invitation renewed. Email was not sent; use the development preview.",
      );
      setPreview(result.development_link || "");
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  }
  return (
    <>
      <PageTitle title="Administrator access" />
      <main className="content-page account-access">
        <div className="access-toolbar">
          <p>
            Manage who can use the administrator console. Staff participation
            roles are managed separately.
          </p>
          <Button
            disabled={busy || loading || !!error}
            onClick={() => setInvite(true)}
          >
            Invite administrator
          </Button>
          <Button secondary disabled={busy || loading} onClick={reload}>
            Reload
          </Button>
        </div>
        <ErrorBox error={error || actionError} />
        {message && <p role="status">{message}</p>}
        <DevelopmentPreview link={preview} />
        {loading ? (
          <Loading />
        ) : (
          !error && (
            <>
              <h2>Console users</h2>
              <div className="access-list">
                {data.users.map((user) => (
                  <article className="access-row" key={user.id}>
                    <div className="access-identity">
                      <strong>
                        {user.name}
                        {user.id === currentUserId ? " (you)" : ""}
                      </strong>
                      <span>{user.email}</span>
                      <span>
                        {user.role} · {user.active ? "Active" : "Deactivated"}
                      </span>
                    </div>
                    <Button
                      secondary
                      disabled={busy}
                      aria-label={`Manage access for ${user.name}`}
                      onClick={() => setEditing(user)}
                    >
                      Manage access
                    </Button>
                  </article>
                ))}
              </div>
              <h2>Invitations</h2>
              <InvitationList
                invitations={data.invitations}
                busy={busy}
                act={invitationAction}
              />
            </>
          )
        )}
        {invite && (
          <Modal title="Invite administrator" onClose={closeInvite}>
            <InviteForm
              endpoint="/admin-users/invitations"
              consoleInvite
              onDone={(result) => {
                setInvite(false);
                setPreview(result.development_link || "");
                setMessage(
                  result.delivery === "sent"
                    ? "Invitation email accepted for delivery."
                    : "Invitation created. Email was not sent; use the development preview.",
                );
                reload();
              }}
              onAttempt={reload}
            />
          </Modal>
        )}
        {editing && (
          <Modal title={`Manage access: ${editing.name}`} onClose={closeEdit}>
            <UserAccessForm
              user={editing}
              self={editing.id === currentUserId}
              onDone={() => {
                setEditing(null);
                setMessage("Administrator access updated.");
                reload();
              }}
              onConflict={() => {
                setEditing(null);
                reload();
                setActionError(
                  "This account changed. Review the refreshed list before making another change.",
                );
              }}
            />
          </Modal>
        )}
      </main>
    </>
  );
}
function InviteForm({
  endpoint,
  consoleInvite = false,
  email = "",
  onDone,
  onAttempt,
}: {
  endpoint: string;
  consoleInvite?: boolean;
  email?: string;
  onDone: (result: Delivery) => void;
  onAttempt: () => void;
}) {
  const [address, setAddress] = useState(email),
    [name, setName] = useState(""),
    [role, setRole] = useState("manager"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="account-auth"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const result = await api<Delivery>(endpoint, {
            method: "POST",
            body: JSON.stringify(
              consoleInvite
                ? { email: address.trim(), name: name.trim(), role }
                : { email: address.trim() },
            ),
          });
          onDone(result);
        } catch (err) {
          setError((err as Error).message);
          onAttempt();
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <fieldset disabled={busy}>
        {consoleInvite && (
          <Field label="Name" required>
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field
          label="Email address"
          required
          hint={
            email
              ? "To use a different address, update the member profile first."
              : undefined
          }
        >
          <input
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            readOnly={!!email}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        {consoleInvite && <RoleField value={role} onChange={setRole} />}
        <p>
          The invitation expires in seven days. The recipient will set their own
          password.
        </p>
        <Button disabled={busy}>
          {busy ? "Creating invitation…" : "Create invitation"}
        </Button>
      </fieldset>
    </form>
  );
}
function UserAccessForm({
  user,
  self,
  onDone,
  onConflict,
}: {
  user: ConsoleUser;
  self: boolean;
  onDone: () => void;
  onConflict: () => void;
}) {
  const [role, setRole] = useState(user.role),
    [active, setActive] = useState(user.active),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="account-auth"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        if (
          self &&
          !window.confirm(
            "Changing your own access will sign you out. Continue?",
          )
        )
          return;
        setBusy(true);
        setError("");
        try {
          await api(`/admin-users/${user.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              ...(roles.includes(role) ? { role } : {}),
              active,
              expected_revision: user.revision,
            }),
          });
          if (self) window.location.replace("/");
          else onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      {error && (
        <Button secondary type="button" onClick={onConflict}>
          Reload user list
        </Button>
      )}
      <fieldset disabled={busy}>
        <RoleField value={role} onChange={setRole} />
        <Field label="Account status">
          <select
            value={active ? "active" : "inactive"}
            onChange={(e) => setActive(e.target.value === "active")}
          >
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
          </select>
        </Field>
        <p>
          Role changes and deactivation sign this user out. Records and history
          are preserved. Your organization must keep at least one active owner.
        </p>
        <Button
          disabled={busy || (role === user.role && active === user.active)}
        >
          {busy ? "Saving…" : "Save access"}
        </Button>
      </fieldset>
    </form>
  );
}
export function MemberAccountAccess({
  personId,
  email,
  role,
}: {
  personId: string;
  email: string;
  role: string;
}) {
  return ["owner", "admin"].includes(role) ? (
    <MemberAccessManager
      key={personId + email}
      personId={personId}
      email={email}
    />
  ) : null;
}
function MemberAccessManager({
  personId,
  email,
}: {
  personId: string;
  email: string;
}) {
  const base = `/people/${personId}`;
  const { data, loading, error, reload } = useData<{
    state: string;
    account: { email: string } | null;
    invitations: Invitation[];
    eligible: boolean;
    reason: string;
  }>(base + "/account-access", {
    state: "none",
    account: null,
    invitations: [],
    eligible: false,
    reason: "",
  });
  const [invite, setInvite] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState("");
  const close = useCallback(() => setInvite(false), []);
  return (
    <section className="member-account-access">
      <div className="access-toolbar">
        <h2>Member account access</h2>
        <Button secondary disabled={loading || busy} onClick={reload}>
          Reload account access
        </Button>
      </div>
      <ErrorBox error={error || actionError} />
      {message && <p role="status">{message}</p>}
      <DevelopmentPreview link={preview} />
      {loading ? (
        <Loading />
      ) : (
        !error && (
          <>
            <p>
              {data.account
                ? `Account activated: ${data.account.email}`
                : data.reason ||
                  "Invite this adult to sign in using their existing member profile. Family relationships and registration history are preserved."}
            </p>
            {data.eligible && data.state !== "pending" && (
              <Button disabled={busy} onClick={() => setInvite(true)}>
                Invite member
              </Button>
            )}
            <InvitationList
              invitations={data.invitations}
              busy={busy}
              act={async (i, action) => {
                if (
                  busy ||
                  (action === "revoke" &&
                    !window.confirm(`Revoke the invitation for ${i.email}?`))
                )
                  return;
                setBusy(true);
                setActionError("");
                setPreview("");
                setMessage("");
                try {
                  const result = await api<Delivery>(
                    `${base}/account-invitations/${i.id}${action === "resend" ? "/resend" : ""}`,
                    { method: action === "resend" ? "POST" : "DELETE" },
                  );
                  setPreview(result.development_link || "");
                  setMessage(
                    action === "revoke"
                      ? "Invitation revoked."
                      : result.delivery === "sent"
                        ? "Invitation email accepted for delivery."
                        : "Invitation renewed. Email was not sent; use the development preview.",
                  );
                } catch (err) {
                  setActionError((err as Error).message);
                } finally {
                  setBusy(false);
                  reload();
                }
              }}
            />
          </>
        )
      )}
      {invite && (
        <Modal title="Invite member to activate account" onClose={close}>
          <InviteForm
            endpoint={base + "/account-invitations"}
            email={email}
            onAttempt={reload}
            onDone={(result) => {
              setInvite(false);
              setPreview(result.development_link || "");
              setMessage(
                result.delivery === "sent"
                  ? "Invitation email accepted for delivery."
                  : "Invitation created. Email was not sent; use the development preview.",
              );
              reload();
            }}
          />
        </Modal>
      )}
    </section>
  );
}
