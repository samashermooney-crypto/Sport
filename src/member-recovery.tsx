import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "./api";
import { Button, ErrorBox, Field } from "./components";

export function MemberRecovery({
  org,
  reset,
  changed,
}: {
  org: string;
  reset: boolean;
  changed: () => void;
}) {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState("");
  const root = `/site/${org}/account`;
  const token = params.get("token") || "";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (reset && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ message?: string; development_link?: string }>(
        `/member/${org}/${reset ? "reset-password" : "forgot-password"}`,
        {
          method: "POST",
          body: JSON.stringify(reset ? { token, password } : { email }),
        },
      );
      setMessage(
        reset
          ? "Your password has been reset. Sign in with your new password. Previous sessions have been signed out."
          : result.message || "Check your email for a reset link.",
      );
      setPreview(result.development_link || "");
      setPassword("");
      setConfirmation("");
      if (reset) changed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="member-access member-recovery">
      <h1>{reset ? "Choose a new password" : "Reset your password"}</h1>
      <ErrorBox error={error} />
      {message ? (
        <>
          <p role="status">{message}</p>
          {preview && (
            <div className="member-email-preview">
              <strong>Local development email preview</strong>
              <p>
                Email was not sent. Use this link to test password recovery in
                this workspace.
              </p>
              <Link className="button" to={preview}>
                Open password reset link
              </Link>
            </div>
          )}
        </>
      ) : reset && !/^[a-f0-9]{64}$/.test(token) ? (
        <p>
          This reset link is incomplete or invalid. Request a new link below.
        </p>
      ) : (
        <form onSubmit={submit}>
          {reset ? (
            <>
              <p>
                Use 12–128 characters. Resetting your password signs out your
                existing sessions.
              </p>
              <Field label="New password" required>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Confirm new password" required>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  disabled={busy}
                />
              </Field>
            </>
          ) : (
            <>
              <p>Enter the email address used for your member account.</p>
              <Field label="Email" required>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
              </Field>
            </>
          )}
          <Button type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : reset
                ? "Reset password"
                : "Send reset link"}
          </Button>
        </form>
      )}
      {reset && !message && (
        <p>
          <Link to={root + "/forgot-password"}>Request a new reset link</Link>
        </p>
      )}
      <p>
        <Link to={root + "/login"}>Back to sign in</Link>
      </p>
    </section>
  );
}
