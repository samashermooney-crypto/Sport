type DatabaseRole = 'app' | 'admin';

/**
 * Resolve the database used by local Playwright fixtures. The explicit URLs
 * support isolated QA stacks whose Docker host ports are remapped; normal
 * per-track runs continue to derive the URL from PORT_OFFSET.
 */
export function e2eDatabaseUrl(role: DatabaseRole): string {
  const envName = `ATHLENTRY_E2E_DATABASE_${role.toUpperCase()}_URL`;
  const configured = process.env[envName];
  if (configured) return configured;

  const offset = Number(process.env.PORT_OFFSET ?? '0');
  const username = role === 'app' ? 'athlentry_app' : 'athlentry_admin';
  return `postgres://${username}@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`;
}

export function e2eApiBaseUrl(): string {
  const configuredPort = process.env.ATHLENTRY_E2E_API_PORT;
  const port =
    configuredPort ?? String(3001 + Number(process.env.PORT_OFFSET ?? '0'));
  return `http://127.0.0.1:${port}`;
}

export function e2eMailpitApiBaseUrl(): string {
  const configuredPort = process.env.ATHLENTRY_E2E_MAILPIT_API_PORT;
  const port =
    configuredPort ?? String(8025 + Number(process.env.PORT_OFFSET ?? '0'));
  return `http://127.0.0.1:${port}`;
}
