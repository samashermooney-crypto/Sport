import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function seriousAccessibilityViolations(page: Page) {
  await page.evaluate(async () => {
    const heading = document.querySelector('main h1');
    if (!heading) return;
    await Promise.all(
      heading
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter(({ impact }) => impact === 'serious' || impact === 'critical')
    .map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    }));
}

const legalDrafts = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'dpa', title: 'Data Processing Addendum' },
  { slug: 'acceptable-use', title: 'Acceptable Use Policy' },
  { slug: 'subprocessors', title: 'Subprocessors' },
  { slug: 'security', title: 'Security Overview' },
  { slug: 'accessibility', title: 'Accessibility Statement' },
];

test('public landing and pricing routes link to the working platform entry point', async ({
  page,
}) => {
  await page.goto('/welcome');
  await expect(
    page.getByRole('heading', { name: /Your next season starts here/ }),
  ).toBeVisible();
  expect(await seriousAccessibilityViolations(page)).toEqual([]);
  await page
    .getByRole('link', { name: 'Pricing', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: /Room to run your next season/ }),
  ).toBeVisible();
  expect(await seriousAccessibilityViolations(page)).toEqual([]);
  await expect(
    page.getByRole('link', { name: 'Open Athlentry' }),
  ).toHaveAttribute('href', '/');
});

test('every public legal page is marked as a draft pending review', async ({
  page,
}) => {
  for (const document of legalDrafts) {
    await page.goto(`/legal/${document.slug}`);
    await expect(
      page.getByRole('heading', { name: document.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(
      'DRAFT — requires legal review',
    );
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
  }
});
