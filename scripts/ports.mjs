export function portOffset(env = process.env) {
  const offset = Number(env.PORT_OFFSET ?? '0');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw new Error('PORT_OFFSET must be an integer from 0 to 10000');
  }
  return offset;
}

export function localPorts(env = process.env) {
  const offset = portOffset(env);
  return {
    postgres: 5432 + offset,
    stripeMock: 12111 + offset,
    mailpitApi: 8025 + offset,
    mailpitSmtp: 1025 + offset,
    api: 3001 + offset,
    web: 5173 + offset,
  };
}

export function composePortEnv(env = process.env) {
  const ports = localPorts(env);
  return {
    ...env,
    ATHLENTRY_POSTGRES_PORT: String(ports.postgres),
    ATHLENTRY_STRIPE_MOCK_PORT: String(ports.stripeMock),
    ATHLENTRY_MAILPIT_API_PORT: String(ports.mailpitApi),
    ATHLENTRY_MAILPIT_SMTP_PORT: String(ports.mailpitSmtp),
  };
}
