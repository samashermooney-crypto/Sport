import { createHash } from "node:crypto";

const fail = (message, status = 503) =>
  Object.assign(new Error(message), { status });
export const tokenDigest = (token) =>
  createHash("sha256").update(token).digest("hex");

// Development preview returns a labeled link instead of sending email.
// Live delivery requires the same account-email configuration as member auth.
export function authDeliveryMode(env = process.env) {
  return {
    preview:
      env.NODE_ENV !== "production" &&
      env.AUTH_EMAIL_DELIVERY_ENABLED !== "true",
    configured:
      env.AUTH_EMAIL_DELIVERY_ENABLED === "true" &&
      !!env.RESEND_API_KEY &&
      !!env.MAIL_FROM &&
      !!env.PUBLIC_URL,
  };
}

export function authLinkUrl(env, path) {
  const url = new URL(path, env.PUBLIC_URL || "https://example.test");
  if (env.NODE_ENV === "production" && url.protocol !== "https:")
    throw fail("Account email delivery requires a secure public URL.");
  return url.href;
}

// Returns "preview" without sending when delivery is disabled in development.
// Otherwise requires a configured provider or an injected `send({to,url})`.
// The token is used only to derive a provider idempotency key, never returned.
export async function deliverAuthLink({
  env = process.env,
  send,
  to,
  path,
  subject,
  text,
  idempotency,
  token,
}) {
  const mode = authDeliveryMode(env);
  if (mode.preview && !send) return "preview";
  if (!send && !mode.configured)
    throw fail(
      "Account email delivery is not configured. Contact the organization.",
    );
  const url = authLinkUrl(env, path);
  if (send) {
    await send({ to, url });
    return "sent";
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `${idempotency}-${tokenDigest(token)}`,
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject,
      text: `${text} ${url}`,
    }),
  });
  if (!response.ok)
    throw fail("The email could not be sent. Please try again later.");
  return "sent";
}
