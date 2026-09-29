import { expect, test } from '@playwright/test';

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
  await page
    .getByRole('link', { name: 'Pricing', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: /Room to run your next season/ }),
  ).toBeVisible();
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
  }
});
