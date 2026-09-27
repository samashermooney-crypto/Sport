import { expect, test } from '@playwright/test';

import { decodeBase32, totpCode } from '../server/src/modules/auth/totp';

import { accessibilityViolations } from './axe';

const mailpitApiPort = 8025 + Number(process.env.PORT_OFFSET ?? '0');

test.beforeEach(async ({ request }) => {
  await expect
    .poll(
      async () => {
        try {
          return (await request.get('/healthz')).status();
        } catch {
          return 0;
        }
      },
      { timeout: 30_000, message: 'API health endpoint should be ready' },
    )
    .toBe(200);
});

test('sign-in and reset request are accessible and functional', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Welcome back.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: /Email address/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(
    page.getByRole('heading', { name: 'Reset your password' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: /Email address/ })
    .fill(
      `unknown-${testInfo.project.name}-${Date.now().toString()}@example.test`,
    );
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
});

test('new account verifies its preview email and signs in', async ({
  page,
  request,
}, testInfo) => {
  const email = `e2e-${testInfo.project.name}-${Date.now().toString()}@example.test`;
  const password = 'Pinecones!7348Ridge';
  await page.addInitScript(() => {
    let subscription: {
      endpoint: string;
      toJSON: () => object;
      unsubscribe: () => Promise<boolean>;
    } | null = null;
    const registration = {
      pushManager: {
        getSubscription: () => Promise.resolve(subscription),
        subscribe: () => {
          const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
          subscription = {
            endpoint,
            toJSON: () => ({
              endpoint,
              keys: { p256dh: 'test-public-key', auth: 'test-auth-key' },
            }),
            unsubscribe: () => {
              subscription = null;
              return Promise.resolve(true);
            },
          };
          return Promise.resolve(subscription);
        },
      },
    };
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: Symbol('PushManager'),
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { requestPermission: () => Promise.resolve('granted') },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: () => Promise.resolve(registration),
        getRegistration: () => Promise.resolve(registration),
      },
    });
  });
  await page.goto('/sign-up');
  await expect(
    page.getByRole('heading', { name: 'Create your account' }),
  ).toBeVisible();
  await expect(
    page.locator('summary', { hasText: 'Terms of service' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('textbox', { name: /First name/ }).fill('Alex');
  await page.getByRole('textbox', { name: /Last name/ }).fill('Tester');
  await page.getByRole('textbox', { name: /Email address/ }).fill(email);
  await page.getByLabel('Date of birth').fill('1990-04-06');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('checkbox', { name: /Terms of service/ }).check();
  await page.getByRole('checkbox', { name: /Privacy notice/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('verification link');

  let verificationUrl = '';
  await expect
    .poll(async () => {
      const response = await request.get(
        `http://127.0.0.1:${String(mailpitApiPort)}/api/v1/messages`,
      );
      const mailbox = (await response.json()) as {
        messages: Array<{ To: Array<{ Address: string }>; Snippet: string }>;
      };
      verificationUrl =
        mailbox.messages
          .filter((message) =>
            message.To.some((recipient) => recipient.Address === email),
          )
          .map(
            (message) =>
              /https?:\/\/[^\s]+\/verify\/[A-Za-z0-9_-]+/.exec(
                message.Snippet,
              )?.[0] ?? '',
          )[0] ?? '';
      return verificationUrl;
    })
    .not.toBe('');

  await page.goto(verificationUrl);
  await expect(
    page.getByRole('heading', { name: 'Verify your email' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByRole('status')).toContainText('Email verified');
  await page.getByRole('link', { name: 'Return to sign in' }).click();
  await page.getByRole('textbox', { name: /Email address/ }).fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome, Alex.' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('link', { name: 'Account security' }).click();
  await expect(
    page.getByRole('heading', { name: 'Account security' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('(current)')).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(
    page.getByRole('img', { name: 'Authenticator setup QR code' }),
  ).toBeVisible();
  const secret = await page.locator('.mfa-qr + p code').textContent();
  expect(secret).toBeTruthy();
  const code = totpCode(
    decodeBase32(secret ?? ''),
    Math.floor(Date.now() / 30_000),
  );
  await page.getByLabel('Six-digit authenticator code').fill(code);
  await page.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(
    page.getByText('Save these 10 recovery codes now.'),
  ).toBeVisible();
  await expect(page.locator('.recovery-codes li')).toHaveCount(10);
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Confirm identity' }).click();
  await expect(page.getByRole('status')).toContainText('Identity confirmed');
  await page.getByRole('button', { name: 'Regenerate recovery codes' }).click();
  await expect(page.locator('.recovery-codes li')).toHaveCount(10);
  await page.getByRole('button', { name: 'I saved these codes' }).click();
  await page
    .getByRole('button', { name: 'Enable browser notifications' })
    .click();
  await expect(
    page.getByText('Browser notifications enabled on this device.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Revoke device' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Revoke device' }).click();
  await expect(page.getByText('Notification device revoked.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke device' })).toHaveCount(
    0,
  );
  await page.goto('/start');
  await expect(
    page.getByRole('heading', { name: 'Start an organization' }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Soccer', exact: true }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  const orgSlug = `e2e-${Date.now().toString()}`;
  await page
    .getByRole('textbox', { name: 'Organization name' })
    .fill('E2E Youth Club');
  await page.getByRole('textbox', { name: 'Organization URL' }).fill(orgSlug);
  await expect(page.getByRole('status')).toContainText('URL available');
  await page
    .getByRole('textbox', { name: 'Street address' })
    .fill('1 Main Street');
  await page.getByRole('textbox', { name: 'City' }).fill('Chicago');
  await page.getByRole('textbox', { name: 'State' }).fill('IL');
  await page.getByRole('textbox', { name: 'ZIP code' }).fill('60601');
  await page.getByRole('checkbox', { name: 'Soccer', exact: true }).check();
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(
    page.getByRole('heading', { name: 'E2E Youth Club is ready for setup' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('link', { name: 'Review safety requirements' }).click();
  await expect(
    page.getByRole('heading', { name: 'Safety requirements' }),
  ).toBeVisible();
  const backgroundCheck = page.getByRole('region', {
    name: 'Background check',
  });
  await expect(
    backgroundCheck.getByRole('checkbox', { name: 'Requirement active' }),
  ).toBeChecked();
  await backgroundCheck
    .getByRole('checkbox', { name: 'Requirement active' })
    .uncheck();
  await backgroundCheck
    .getByRole('button', { name: 'Save requirement' })
    .click();
  await expect(backgroundCheck.getByRole('status')).toContainText('saved');
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('link', { name: 'account security' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back.' }),
  ).toBeVisible();
});
