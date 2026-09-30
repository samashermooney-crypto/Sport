import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { expect, test } from '@playwright/test';
import { importBatchPreviewSchema } from '@shared/schemas/imports';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';
import { accessibilityViolations } from '../axe';
import { e2eDatabaseUrl } from '../database';

const importSize = 2_000;
const duplicateCount = 3;
const invalidCount = 5;
const expectedCreateCount = importSize - duplicateCount - invalidCount;

test('staff previews, imports, and rolls back the required 2,000-row batch', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const database = createDatabase(e2eDatabaseUrl('app'));
  const importPrefix = `import-${randomUUID()}`;
  const filename = 'two-thousand-athletes.csv';
  const duplicatePeople = [
    {
      firstName: 'DuplicateAlpha',
      lastName: 'Roster',
      dateOfBirth: '2012-04-03',
    },
    {
      firstName: 'DuplicateBravo',
      lastName: 'Roster',
      dateOfBirth: '2011-09-12',
    },
    {
      firstName: 'DuplicateCharlie',
      lastName: 'Roster',
      dateOfBirth: '2013-02-20',
    },
  ];

  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const duplicatePersonIds: string[] = [];
    for (const person of duplicatePeople)
      duplicatePersonIds.push(await factories.person(actor, person));
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute(),
    );
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: String(testInfo.project.use.baseURL),
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const duplicateRows = duplicatePeople.map(
      (person) =>
        `${person.firstName},${person.lastName},${person.dateOfBirth},,`,
    );
    const mixedDateFormats = ['2012-04-03', '4/3/2012', '2012/4/3'];
    const uniqueRows = Array.from(
      { length: expectedCreateCount },
      (_, index) => {
        const rowNumber = String(index + 1).padStart(4, '0');
        const dateOfBirth = mixedDateFormats[index % mixedDateFormats.length];
        if (!dateOfBirth) throw new Error('Missing mixed date fixture value');
        return `Athlete${rowNumber},Roster,${dateOfBirth},${importPrefix}-${rowNumber}@example.invalid,`;
      },
    );
    const invalidRows = [
      `,Invalid,2012-04-03,invalid-first-${randomUUID()}@example.invalid,`,
      `InvalidLast,,2012-04-03,invalid-last-${randomUUID()}@example.invalid,`,
      `InvalidDate,Roster,2012-02-30,invalid-date-${randomUUID()}@example.invalid,`,
      `InvalidEmail,Roster,2012-04-03,not-an-email,`,
      `InvalidGender,Roster,2012-04-03,invalid-gender-${randomUUID()}@example.invalid,Martian`,
    ];
    const dataRows = [...duplicateRows, ...uniqueRows, ...invalidRows];
    expect(dataRows).toHaveLength(importSize);
    const csv = ['First Name,Last Name,DOB,Email,Gender', ...dataRows].join(
      '\n',
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/console/orgs/${actor.orgId}/imports`);
    await expect(
      page.getByRole('heading', { name: 'Import records' }),
    ).toBeVisible();
    await page.getByLabel(/CSV or XLSX file/).setInputFiles({
      name: filename,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    const previewResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/v1/imports/orgs/${actor.orgId}/batches`,
    );
    await page.getByRole('button', { name: 'Preview import' }).click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status()).toBe(201);
    const preview = importBatchPreviewSchema.parse(
      await previewResponse.json(),
    );
    expect(preview.batch.stats).toEqual({
      total: importSize,
      create: expectedCreateCount,
      update: 0,
      merge: 0,
      skip: duplicateCount,
      invalid: invalidCount,
    });
    expect(
      preview.rows.slice(0, duplicateCount).map((row) => row.action),
    ).toEqual(['skip', 'skip', 'skip']);
    expect(
      preview.rows
        .slice(0, duplicateCount)
        .map((row) => row.issues.map((issue) => issue.code)),
    ).toEqual([
      ['possible_duplicate'],
      ['possible_duplicate'],
      ['possible_duplicate'],
    ]);
    expect(
      preview.rows
        .slice(duplicateCount, duplicateCount + 3)
        .map((row) => row.normalized?.dateOfBirth),
    ).toEqual(['2012-04-03', '2012-04-03', '2012-04-03']);
    const invalidPreviewRows = preview.rows.slice(-invalidCount);
    expect(invalidPreviewRows.map((row) => row.action)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ]);
    expect(invalidPreviewRows.map((row) => row.issues[0]?.code)).toEqual([
      'required',
      'required',
      'invalid_date',
      'invalid_email',
      'invalid_gender',
    ]);

    await expect(
      page.getByRole('heading', { name: 'Batch preview' }),
    ).toBeVisible();
    await expect(
      page.getByText(`${String(expectedCreateCount)} to create`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(`${String(duplicateCount)} to skip`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`${String(invalidCount)} invalid`, { exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const commitPath = `/api/v1/imports/orgs/${actor.orgId}/batches/${preview.batch.id}/commit`;
    const commitResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === commitPath,
    );
    const commitStartedAt = performance.now();
    await page.getByRole('button', { name: 'Commit valid rows' }).click();
    const commitResponse = await commitResponsePromise;
    const commitDurationMs = performance.now() - commitStartedAt;
    expect(commitResponse.ok()).toBe(true);
    expect(commitDurationMs).toBeLessThan(30_000);
    await expect(
      page.getByText(`${filename} · ${String(importSize)} rows · committed`, {
        exact: false,
      }),
    ).toBeVisible();

    const rollbackResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(
          `/batches/${preview.batch.id}/rollback`,
        ),
    );
    await page
      .getByRole('button', { name: 'Roll back untouched rows' })
      .click();
    const rollbackResponse = await rollbackResponsePromise;
    expect(rollbackResponse.ok()).toBe(true);
    await expect(
      page.getByText(`${filename} · ${String(importSize)} rows · rolled_back`, {
        exact: false,
      }),
    ).toBeVisible();

    const imported = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('people')
        .select(['email', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('email', 'like', `${importPrefix}-%@example.invalid`)
        .execute(),
    );
    expect(imported).toHaveLength(expectedCreateCount);
    expect(new Set(imported.map((person) => person.status))).toEqual(
      new Set(['archived']),
    );
    const unchangedDuplicates = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('people')
        .select(['id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', duplicatePersonIds)
        .execute(),
    );
    expect(unchangedDuplicates).toHaveLength(duplicateCount);
    expect(new Set(unchangedDuplicates.map((person) => person.status))).toEqual(
      new Set(['active']),
    );
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
