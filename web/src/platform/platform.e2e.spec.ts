import { createHash, randomBytes, randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import pg from 'pg';

async function accessibilityViolations(
  page: import('@playwright/test').Page,
): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter(
      (violation) =>
        violation.impact === 'serious' || violation.impact === 'critical',
    )
    .map((violation) => `${violation.id}: ${violation.description}`);
}

test('platform staff can inspect and suspend an organization accessibly', async ({
  page,
  context,
  request,
}) => {
  const offset = Number(process.env.PORT_OFFSET ?? '0');
  const database = new pg.Client({
    connectionString: `postgres://athlentry_admin@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  });
  await database.connect();
  const accountId = randomUUID();
  const orgId = randomUUID();
  const slug = `platform-${orgId.slice(0, 8)}`;
  const orgName = `Platform Browser Club ${orgId.slice(0, 8)}`;
  try {
    await database.query(
      `INSERT INTO accounts
      (id, email, email_verified_at, first_name, last_name, date_of_birth)
      VALUES ($1, $2, now(), 'Platform', 'Tester', '1990-01-01')`,
      [accountId, `${accountId}@example.invalid`],
    );
    await database.query(
      `INSERT INTO platform_staff(account_id, role, active)
      VALUES ($1, 'super_admin', true)`,
      [accountId],
    );
    await database.query(
      `INSERT INTO organizations(id, slug, name, kind, timezone, status)
      VALUES ($1, $2, $3, 'club', 'UTC', 'active')`,
      [orgId, slug, orgName],
    );
    const now = new Date();
    const sessionToken = randomBytes(32).toString('base64url');
    await database.query(
      `INSERT INTO sessions
      (id, token_hash, account_id, kind, client, privileged, mfa_verified_at,
        idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, $3, 'cookie', 'web', true, $4,
        $5, $6)`,
      [
        randomUUID(),
        createHash('sha256').update(sessionToken).digest(),
        accountId,
        now,
        new Date(now.getTime() + 12 * 60 * 60 * 1000),
        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      ],
    );
    await context.addCookies([
      {
        name: '__Host-athlentry_session',
        value: sessionToken,
        url: `https://127.0.0.1:${String(5173 + offset)}`,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await expect
      .poll(async () => (await request.get('/healthz')).status())
      .toBe(200);
    await page.goto('/platform');
    await expect(
      page.getByRole('heading', { name: 'Platform', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Organizations' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole('textbox', { name: 'Search' }).fill(orgName);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: orgName }).click();
    await expect(page.getByText('Not connected')).toBeVisible();
    await page.getByRole('button', { name: 'Suspend' }).click();
    await expect(page.getByText('Organization status updated.')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Reactivate' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Health' }).click();
    await expect(
      page.getByRole('heading', { name: 'System health' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.end();
  }
});
