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

test('platform staff and portal notifications work accessibly', async ({
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
  const notificationId = randomUUID();
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
    await database.query(
      `INSERT INTO org_memberships(id, org_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [randomUUID(), orgId, accountId],
    );
    await database.query(
      `INSERT INTO notifications(id, org_id, account_id, type, payload, delivered_channels)
       VALUES ($1, $2, $3, 'registration.confirmed', '{}'::jsonb, ARRAY['in_app'])`,
      [notificationId, orgId, accountId],
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
    expect((await request.get('/api/v1/stream')).status()).toBe(401);
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
    await page.getByRole('button', { name: 'Reactivate' }).click();
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Reason for read-only impersonation' })
      .fill('Investigating an organization support request');
    await page
      .getByRole('button', { name: 'Start read-only impersonation' })
      .click();
    await expect(
      page.getByText(`Read-only impersonation for organization ${orgId}`),
    ).toBeVisible();
    const impersonation = await database.query<{
      id: string;
      expires_in_seconds: number;
    }>(
      `SELECT id, EXTRACT(EPOCH FROM (expires_at - started_at))::integer AS expires_in_seconds
       FROM platform_impersonations WHERE staff_account_id = $1 AND target_organization_id = $2`,
      [accountId, orgId],
    );
    expect(impersonation.rows).toMatchObject([{ expires_in_seconds: 3600 }]);
    const impersonationId = impersonation.rows[0]?.id;
    if (!impersonationId)
      throw new Error('Impersonation record was not created');
    await page
      .getByRole('link', { name: 'Review safety requirements' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Safety requirements' }),
    ).toBeVisible();
    await expect(
      page.getByText('Viewing as platform staff. Changes are disabled.'),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    const guardedInbox = page.waitForRequest(
      (request) =>
        request.url().includes(`/orgs/${orgId}/notifications`) &&
        request.headers()['x-athlentry-impersonation'] === impersonationId,
    );
    await page.goto(`/portal/orgs/${orgId}/notifications`);
    await guardedInbox;
    await expect(
      page.getByText(`Read-only impersonation for organization ${orgId}`),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark read' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('checkbox', { name: 'marketing · Email' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'End impersonation' }).click();
    await expect(
      page.getByText(`Read-only impersonation for organization ${orgId}`),
    ).toHaveCount(0);
    const audits = await database.query<{ action: string }>(
      'SELECT action FROM platform_audit_log WHERE impersonation_id = $1 ORDER BY created_at',
      [impersonationId],
    );
    const actions = audits.rows.map((row) => row.action);
    expect(actions).toContain('impersonation.start');
    expect(actions).toContain('impersonation.request');
    expect(actions).toContain('impersonation.end');
    const tenantAudits = await database.query<{ impersonation_id: string }>(
      `SELECT impersonation_id FROM audit_log WHERE org_id = $1 AND action = 'platform.impersonation_read'`,
      [orgId],
    );
    expect(tenantAudits.rows.length).toBeGreaterThanOrEqual(1);
    expect(
      tenantAudits.rows.every(
        (row) => row.impersonation_id === impersonationId,
      ),
    ).toBe(true);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.goto('/platform');
    await page.getByRole('button', { name: 'Health' }).click();
    await expect(
      page.getByRole('heading', { name: 'System health' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.goto(`/portal/orgs/${orgId}/notifications`);
    await expect(
      page.getByRole('heading', { name: 'Notifications', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#preferences')).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: 'announcement · SMS' }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: 'announcement · Push' }),
    ).not.toBeChecked();
    await expect(page.getByText('Registration confirmed')).toBeVisible();
    await page.getByRole('button', { name: 'Mark read' }).click();
    await expect(page.getByRole('button', { name: 'Mark read' })).toHaveCount(
      0,
    );
    const readState = await database.query<{ read_at: Date | null }>(
      'SELECT read_at FROM notifications WHERE id = $1',
      [notificationId],
    );
    expect(readState.rows[0]?.read_at).not.toBeNull();
    const marketingEmail = page.getByRole('checkbox', {
      name: 'marketing · Email',
    });
    await expect(marketingEmail).not.toBeChecked();
    await marketingEmail.click();
    await expect(marketingEmail).toBeChecked();
    const preference = await database.query<{ enabled: boolean }>(
      `SELECT enabled FROM communication_preferences
       WHERE org_id = $1 AND account_id = $2 AND category = 'marketing' AND channel = 'email'`,
      [orgId, accountId],
    );
    expect(preference.rows).toMatchObject([{ enabled: true }]);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.end();
  }
});
