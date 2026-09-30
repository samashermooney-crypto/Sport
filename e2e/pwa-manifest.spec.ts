import { expect, test } from '@playwright/test';

test('serves the installable Athlentry manifest and its brand icon', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    if (!response.ok) throw new Error('The app manifest could not be loaded.');
    return (await response.json()) as {
      display: string;
      icons: { src: string; type: string; purpose: string }[];
      name: string;
      theme_color: string;
    };
  });

  expect(manifest).toMatchObject({
    display: 'standalone',
    name: 'Athlentry',
    theme_color: '#2e3034',
  });
  const icon = manifest.icons.find(
    ({ type, purpose }) =>
      type === 'image/svg+xml' && purpose.includes('maskable'),
  );
  expect(icon).toBeDefined();
  const iconResponse = await page.request.get(
    new URL(icon?.src ?? '', page.url()).href,
  );
  expect(iconResponse.ok()).toBe(true);
  expect(iconResponse.headers()['content-type']).toContain('image/svg+xml');
});
