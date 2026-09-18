import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "./api";
import { Button, ErrorBox, Field, PageTitle } from "./components";

type Mode =
  | "forgot-password"
  | "reset-password"
  | "accept-invitation"
  | "change-password";
export function AccountAuth({ mode, org }: { mode: Mode; org?: string }) {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState("");
  const token = params.get("token") || "";
  const forgot = mode === "forgot-password",
    change = mode === "change-password",
    accept = mode === "accept-invitation";
  const root = org ? `/site/${encodeURIComponent(org)}/account` : "";
  const title = forgot
    ? "Reset your password"
    : change
      ? "Change password"
      : accept
        ? org
          ? "Activate your member account"
          : "Accept your invitation"
        : "Choose a new password";
  const validLink = forgot || change || /^[a-f0-9]{64}$/.test(token);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!forgot && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ message?: string; development_link?: string }>(
        `${org ? `/member/${encodeURIComponent(org)}` : "/auth"}/${mode}`,
        {
          method: "POST",
          body: JSON.stringify(
            forgot
              ? { email: email.trim() }
              : change
                ? { current_password: current, new_password: password }
                : { token, password },
          ),
        },
      );
      setPassword("");
      setConfirmation("");
      setCurrent("");
      if (accept) {
        window.location.replace(org ? root + "/dashboard" : "/");
        return;
      }
      setMessage(
        forgot
          ? result.message || "Check your email for a reset link."
          : change
            ? "Password changed. Your other sessions have been signed out."
            : "Password reset. Sign in with your new password. Your previous sessions have been signed out.",
      );
      setPreview(result.development_link || "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const content = (
    <>
      {change ? <h2>{title}</h2> : <h1>{title}</h1>}
      <ErrorBox error={error} />
      {message ? (
        <>
          <p role="status">{message}</p>
          <DevelopmentPreview link={preview} />
          {change && (
            <Button secondary onClick={() => setMessage("")}>
              Change password again
            </Button>
          )}
        </>
      ) : !validLink ? (
        <p>
          This link is incomplete or invalid.{" "}
          {accept
            ? "Ask the organization for a new invitation."
            : "Request a new reset link below."}
        </p>
      ) : (
        <form onSubmit={submit}>
          <p>
            {forgot
              ? "Enter the email address used for your administrator account."
              : accept
                ? "Set a password to finish setting up your account. Use 12–128 characters."
                : "Use 12–128 characters. Your other sessions will be signed out."}
          </p>
          {forgot ? (
            <Field label="Email address" required>
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          ) : (
            <>
              {change && (
                <Field label="Current password" required>
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={current}
                    disabled={busy}
                    onChange={(e) => setCurrent(e.target.value)}
                  />
                </Field>
              )}
              <Field label="New password" required>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
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
                  disabled={busy}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Field>
            </>
          )}
          <Button disabled={busy}>
            {busy
              ? "Please wait…"
              : forgot
                ? "Send reset link"
                : accept
                  ? "Activate account"
                  : change
                    ? "Save password"
                    : "Reset password"}
          </Button>
        </form>
      )}
      {!accept && !change && mode === "reset-password" && (
        <p>
          <Link to={root + "/forgot-password"}>Request a new reset link</Link>
        </p>
      )}
      <p>
        <Link to={org ? root + "/login" : "/"}>
          {change ? "Back to dashboard" : "Back to sign in"}
        </Link>
      </p>
    </>
  );
  if (org)
    return <section className="member-access account-auth">{content}</section>;
  if (change)
    return (
      <>
        <PageTitle title="Account security" />
        <section className="account-auth account-security">{content}</section>
      </>
    );
  return (
    <main className="login-page">
      <div className="login-brand">
        <span className="brand-mark">A</span>
        <strong>ATHLENTRY</strong>
      </div>
      <section className="login-card account-auth">{content}</section>
    </main>
  );
}

export function DevelopmentPreview({ link }: { link: string }) {
  if (!link || !link.startsWith("/") || link.startsWith("//")) return null;
  return (
    <div className="member-email-preview">
      <strong>Local development email preview</strong>
      <p>
        Email was not sent. This link lets you test the account flow in this
        workspace.
      </p>
      <Link className="button secondary" to={link}>
        Open preview link
      </Link>
    </div>
  );
}
