import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { decodeBase32, totpCode } from '../server/src/modules/auth/totp';

import { accessibilityViolations } from './axe';

const mailpitApiPort = 8025 + Number(process.env.PORT_OFFSET ?? '0');

async function previewLink(
  request: APIRequestContext,
  address: string,
  path: string,
): Promise<string> {
  let link = '';
  await expect
    .poll(async () => {
      const response = await request.get(
        `http://127.0.0.1:${String(mailpitApiPort)}/api/v1/messages`,
      );
      const mailbox = (await response.json()) as {
        messages: Array<{ To: Array<{ Address: string }>; Snippet: string }>;
      };
      link =
        mailbox.messages
          .filter((message) =>
            message.To.some((recipient) => recipient.Address === address),
          )
          .map(
            (message) =>
              new RegExp(
                `https?:\\/\\/[^\\s]+\\/${path}\\/[A-Za-z0-9_-]+`,
              ).exec(message.Snippet)?.[0] ?? '',
          )
          .find(Boolean) ?? '';
      return link;
    })
    .not.toBe('');
  return link;
}

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

test('sign-in language switch renders Spanish validation accessibly', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
  await expect(
    page.getByRole('heading', { name: 'Le damos la bienvenida.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByText('Ingrese su correo electrónico.')).toBeVisible();
  expect(await page.locator('html').getAttribute('lang')).toBe('es');
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('new account verifies its preview email and signs in', async ({
  page,
  request,
  browser,
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
        ready: Promise.resolve(registration),
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

  const verificationUrl = await previewLink(request, email, 'verify');

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
  const recoveryCode =
    (await page.locator('.recovery-codes li').first().textContent())?.trim() ??
    '';
  expect(recoveryCode).not.toBe('');
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
  await page.getByRole('link', { name: 'Open organization home' }).click();
  await expect(
    page.getByRole('heading', { name: 'E2E Youth Club' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Review safety requirements' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Manage staff and invitations' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  const invitedEmail = `admin-${email}`;
  const invitedPassword = 'Pinecones!7348Ridge';
  await page
    .getByRole('link', { name: 'Manage staff and invitations' })
    .click();
  const staffUrl = page.url();
  const staffOrgId = /\/orgs\/([0-9a-f-]{36})\/staff$/.exec(
    new URL(staffUrl).pathname,
  )?.[1];
  expect(staffOrgId).toBeTruthy();
  expect(
    (
      await page.request.get(
        `/api/v1/me/notifications/orgs/${String(staffOrgId)}/inbox`,
      )
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.get(
        `/api/v1/orgs/${String(staffOrgId)}/notifications/inbox`,
      )
    ).status(),
  ).toBe(200);
  await page.goto(`/portal/orgs/${String(staffOrgId)}/notifications`);
  await expect(
    page.getByRole('heading', { name: 'Notifications' }),
  ).toBeVisible();
  await expect(page.getByText('No notifications yet.')).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.goto(staffUrl);
  await expect(
    page.getByRole('heading', { name: 'Users and roles' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('textbox', { name: 'Email address' }).fill(invitedEmail);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent');
  const invitationUrl = await previewLink(
    request,
    invitedEmail,
    'invitations/[0-9a-f-]+',
  );
  const recipientContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const recipient = await recipientContext.newPage();
  await recipient.goto('/sign-up');
  await recipient.getByRole('textbox', { name: /First name/ }).fill('Invited');
  await recipient.getByRole('textbox', { name: /Last name/ }).fill('Admin');
  await recipient
    .getByRole('textbox', { name: /Email address/ })
    .fill(invitedEmail);
  await recipient.getByLabel('Date of birth').fill('1990-04-06');
  await recipient.getByLabel('Password').fill(invitedPassword);
  await recipient.getByRole('checkbox', { name: /Terms of service/ }).check();
  await recipient.getByRole('checkbox', { name: /Privacy notice/ }).check();
  await recipient.getByRole('button', { name: 'Create account' }).click();
  await expect(recipient.getByRole('status')).toContainText(
    'verification link',
  );
  await recipient.goto(await previewLink(request, invitedEmail, 'verify'));
  await recipient.getByRole('button', { name: 'Verify email' }).click();
  await recipient.getByRole('link', { name: 'Return to sign in' }).click();
  await recipient
    .getByRole('textbox', { name: /Email address/ })
    .fill(invitedEmail);
  await recipient.getByLabel('Password').fill(invitedPassword);
  await recipient.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    recipient.getByRole('heading', { name: 'Welcome, Invited.' }),
  ).toBeVisible();
  await recipient.goto(invitationUrl);
  await expect(
    recipient.getByRole('heading', { name: 'Join this organization' }),
  ).toBeVisible();
  expect(await accessibilityViolations(recipient)).toEqual([]);
  await recipient.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(recipient.getByRole('status')).toContainText(
    'Invitation accepted',
  );
  await recipient.getByRole('link', { name: 'Open account security' }).click();
  await recipient.getByRole('button', { name: 'Set up authenticator' }).click();
  const recipientSecret = await recipient
    .locator('.mfa-qr + p code')
    .textContent();
  expect(recipientSecret).toBeTruthy();
  await recipient
    .getByLabel('Six-digit authenticator code')
    .fill(
      totpCode(
        decodeBase32(recipientSecret ?? ''),
        Math.floor(Date.now() / 30_000),
      ),
    );
  await recipient.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(
    recipient.getByText('Save these 10 recovery codes now.'),
  ).toBeVisible();
  await recipient.getByRole('button', { name: 'I saved these codes' }).click();
  await page.reload();
  const invitedCard = page.getByRole('region', {
    name: 'Roles for Invited Admin',
  });
  await expect(invitedCard).toBeVisible();
  await invitedCard.getByRole('checkbox', { name: 'admin' }).uncheck();
  await invitedCard.getByRole('checkbox', { name: 'registrar' }).check();
  await invitedCard.getByRole('button', { name: 'Save roles' }).click();
  await expect(invitedCard.getByRole('status')).toContainText('Roles saved');
  await recipient.goto('/me');
  await expect(
    recipient.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();
  await invitedCard.getByRole('button', { name: 'Suspend membership' }).click();
  await expect(invitedCard).toContainText('suspended');
  await invitedCard
    .getByRole('button', { name: 'Reactivate membership' })
    .click();
  await expect(invitedCard).toContainText('active');
  page.once('dialog', (dialog) => void dialog.accept());
  await invitedCard.getByRole('button', { name: 'Remove membership' }).click();
  await expect(invitedCard).toHaveCount(0);
  await recipientContext.close();
  await page.goto(staffUrl.replace('/staff', '/credentials'));
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
  await page.getByRole('button', { name: 'Request deletion review' }).click();
  await expect(page.getByRole('status')).toContainText('privacy review', {
    timeout: 10_000,
  });
  const changedEmail = `changed-${email}`;
  await page.getByLabel('New email address').fill(changedEmail);
  await page.getByRole('button', { name: 'Send confirmation' }).click();
  await expect(page.getByRole('status')).toContainText('new address');
  const emailChangeUrl = await previewLink(
    request,
    changedEmail,
    'verify-email-change',
  );
  await page.goto(emailChangeUrl);
  await expect(
    page.getByRole('heading', { name: 'Confirm your new email' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Confirm email' }).click();
  await expect(page.getByRole('status')).toContainText('Email changed');
  await page.getByRole('link', { name: 'Return to sign in' }).click();
  await page.getByRole('textbox', { name: /Email address/ }).fill(changedEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Verify it’s you' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recoveryCode);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome, Alex.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Account security' }).click();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back.' }),
  ).toBeVisible();
});
