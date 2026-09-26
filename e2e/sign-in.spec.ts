import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe';

test('Phase 0 sign-in shell and API health', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Athlentry')).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(await accessibilityViolations(page)).toEqual([]);
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
});
