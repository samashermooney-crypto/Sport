import { expect, test, type Page } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createWaiversService } from '../server/src/modules/waivers/service';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const orgId = '11111111-1111-4111-8111-111111111111';
const personId = '22222222-2222-4222-8222-222222222222';
const formId = '33333333-3333-4333-8333-333333333333';
const waiverId = '44444444-4444-4444-8444-444444444444';
const signatureId = '55555555-5555-4555-8555-555555555555';
const publishedAt = '2026-09-27T12:00:00.000Z';
const offset = Number(process.env.PORT_OFFSET ?? '0');

const form = {
  id: formId,
  name: 'Family medical details',
  scope: 'person_profile',
  version: 1,
  schema: {
    fields: [
      {
        key: 'emergency_consent',
        type: 'checkbox',
        label: { en: 'Emergency care consent', es: 'Consentimiento médico' },
        required: true,
        options: [],
        tier: 'public',
        appliesTo: ['guardian'],
        profileScoped: true,
        askEverySeason: false,
      },
      {
        key: 'care_notes',
        type: 'textarea',
        label: { en: 'Care notes', es: 'Notas de cuidado' },
        required: true,
        options: [],
        visibility: { fieldKey: 'emergency_consent', equals: true },
        tier: 'restricted',
        appliesTo: ['athlete'],
        profileScoped: false,
        askEverySeason: false,
      },
    ],
  },
  publishedAt,
  retiredAt: null,
  supersedesId: null,
};

test('family member completes a localized conditional form and reuses answers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/auth/me', async (route) =>
    route.fulfill({
      json: {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'guardian@example.invalid',
        firstName: 'Morgan',
        lastName: 'Guardian',
        locale: 'es',
        mfaEnabled: false,
        sessionId: '77777777-7777-4777-8777-777777777777',
        client: 'web',
      },
    }),
  );
  await page.route(
    new RegExp(`/api/v1/forms/orgs/${orgId}/person\\?`),
    (route) => route.fulfill({ json: { items: [form] } }),
  );
  await page.route(
    new RegExp(`/api/v1/forms/orgs/${orgId}/${formId}/reuse\\?`),
    (route) =>
      route.fulfill({
        json: {
          answers: {
            emergency_consent: true,
            care_notes: 'Use inhaler before exercise.',
          },
          reusedFromResponseId: '88888888-8888-4888-8888-888888888888',
        },
      }),
  );
  await page.route(`**/api/v1/forms/orgs/${orgId}/responses`, async (route) => {
    const body = route.request().postDataJSON() as {
      formDefinitionId: string;
      subjectId: string;
      answers: Record<string, unknown>;
    };
    await route.fulfill({
      status: 201,
      json: {
        id: '99999999-9999-4999-8999-999999999999',
        formDefinitionId: body.formDefinitionId,
        definitionVersion: 1,
        subjectType: 'person',
        subjectId: body.subjectId,
        answers: body.answers,
        submittedAt: publishedAt,
        form,
      },
    });
  });

  await page.goto(`/me/family/${orgId}/${personId}/forms`);
  await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible();
  await expect(page.getByLabel('Consentimiento médico')).toBeVisible();
  await expect(page.getByLabel('Notas de cuidado')).toBeHidden();
  await page.getByRole('button', { name: 'Use saved answers' }).click();
  await expect(page.getByLabel('Notas de cuidado')).toHaveValue(
    'Use inhaler before exercise.',
  );
  await expect(page.getByLabel('Consentimiento médico')).toBeChecked();
  await page.getByRole('button', { name: 'Submit form' }).click();
  await expect(page.getByRole('status')).toContainText('Submitted');
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('family member reviews, signs, and retrieves the signed waiver evidence', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const waiver = {
    id: waiverId,
    name: 'Season safety agreement',
    bodyText: 'I agree to follow the safety rules for this season.',
    version: 2,
    requires: 'guardian_if_minor',
    renewal: 'annual_season',
    templateUnreviewed: false,
    publishedAt,
    retiredAt: null,
    supersedesId: null,
  };
  const signature = {
    id: signatureId,
    waiverDocumentId: waiverId,
    documentVersion: 2,
    documentHash: 'a'.repeat(64),
    participantPersonId: personId,
    signerAccountId: '66666666-6666-4666-8666-666666666666',
    signerPersonId: null,
    signerNameTyped: 'Morgan Guardian',
    method: 'online_typed',
    signedAt: publishedAt,
  };
  let signatureItems: (typeof signature)[] = [];
  await page.route('**/api/v1/auth/me', async (route) =>
    route.fulfill({
      json: {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'guardian@example.invalid',
        firstName: 'Morgan',
        lastName: 'Guardian',
        locale: 'en',
        mfaEnabled: false,
        sessionId: '77777777-7777-4777-8777-777777777777',
        client: 'web',
      },
    }),
  );
  await page.route(
    new RegExp(`/api/v1/waivers/orgs/${orgId}/person\\?`),
    (route) => route.fulfill({ json: { items: [waiver] } }),
  );
  await page.route('**/api/v1/people/me/family', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            orgId,
            orgName: 'Example Club',
            people: [
              {
                personId,
                firstName: 'Maya',
                lastName: 'Guardian',
                age: 14,
                relationship: 'guardian',
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(
    new RegExp(`/api/v1/waivers/orgs/${orgId}/signatures\\?`),
    (route) => route.fulfill({ json: { items: signatureItems } }),
  );
  await page.route(
    `**/api/v1/waivers/orgs/${orgId}/${waiverId}/signatures`,
    async (route) => {
      signatureItems = [signature];
      await route.fulfill({
        status: 201,
        json: signature,
      });
    },
  );

  await page.goto(`/me/family/${orgId}/${personId}/waivers`);
  await expect(page.getByText(waiver.bodyText)).toBeVisible();
  await page.getByLabel('Type your full legal name').fill('Morgan Guardian');
  await page.getByRole('button', { name: 'I have read and agree' }).click();
  await expect(page.getByText(/Waiver signed at/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Download signed PDF' }),
  ).toBeVisible();
  await page.route(
    `**/api/v1/waivers/orgs/${orgId}/signatures/${signatureId}/pdf`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: {
          'content-disposition': 'attachment; filename="signed-waiver.pdf"',
        },
        body: '%PDF-1.4 test',
      }),
  );
  const pdfResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(
          `/api/v1/waivers/orgs/${orgId}/signatures/${signatureId}/pdf`,
        ) && response.status() === 200,
  );
  await page.getByRole('link', { name: 'Download signed PDF' }).click();
  const response = await pdfResponse;
  expect(response.status()).toBe(200);
  expect(await response.headerValue('content-type')).toContain(
    'application/pdf',
  );
  expect(await response.headerValue('content-disposition')).toContain(
    'signed-waiver.pdf',
  );
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('staff can retire a published waiver after confirmation and retain its history', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const owner = await factories.actor();
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', owner.orgId)
        .where('account_id', '=', owner.accountId)
        .execute();
    });
    const waivers = createWaiversService(database);
    const draft = await waivers.create(owner, {
      name: 'Season safety agreement',
      bodyText: 'I agree to follow the club safety rules this season.',
      requires: 'guardian_if_minor',
      renewal: 'annual_season',
    });
    await waivers.publish(owner, draft.id, draft.version);
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: owner.actor.accountId,
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

    await page.goto(`/console/orgs/${owner.orgId}/waivers`);
    const waiverRow = page.getByRole('button', {
      name: /Season safety agreement · v1 · Published/,
    });
    await expect(waiverRow).toBeVisible();
    await waiverRow.click();
    await page.getByRole('button', { name: 'Retire published waiver' }).click();
    const confirmation = page.getByRole('dialog', {
      name: 'Retire this published waiver?',
    });
    await expect(confirmation).toContainText(
      'Existing signature records and signed PDFs will remain available.',
    );
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(waiverRow).toContainText('Published');

    await page.getByRole('button', { name: 'Retire published waiver' }).click();
    const confirmedRetirement = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .includes(`/waivers/orgs/${owner.orgId}/${draft.id}/retire`),
    );
    await page
      .getByRole('dialog', { name: 'Retire this published waiver?' })
      .getByRole('button', { name: 'Retire waiver' })
      .click();
    expect((await confirmedRetirement).ok()).toBe(true);
    await expect(
      page.getByRole('button', {
        name: /Season safety agreement · v1 · Retired/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retire published waiver' }),
    ).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});

async function setupDualSignerWaiver(
  page: Page,
  options: {
    age: number;
    relationship: 'guardian' | 'self';
    signatures: Record<string, unknown>[];
  },
): Promise<() => string | null | undefined> {
  const actorId =
    options.relationship === 'self'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab'
      : '66666666-6666-4666-8666-666666666666';
  let signatures = options.signatures;
  let submittedSignerPersonId: string | null | undefined;
  const waiver = {
    id: waiverId,
    name: 'Adult participant and guardian agreement',
    bodyText:
      'Both the adult participant and a guardian must sign this waiver.',
    version: 1,
    requires: 'both',
    renewal: 'every_registration',
    templateUnreviewed: false,
    publishedAt,
    retiredAt: null,
    supersedesId: null,
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        id: actorId,
        email: 'family@example.invalid',
        firstName: 'Morgan',
        lastName: 'Family',
        locale: 'en',
        mfaEnabled: false,
        sessionId: '77777777-7777-4777-8777-777777777777',
        client: 'web',
      },
    }),
  );
  await page.route('**/api/v1/people/me/family', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            orgId,
            orgName: 'Example Club',
            people: [
              {
                personId,
                firstName: 'Avery',
                lastName: 'Athlete',
                age: options.age,
                relationship: options.relationship,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(
    new RegExp(`/api/v1/waivers/orgs/${orgId}/person\\?`),
    (route) => route.fulfill({ json: { items: [waiver] } }),
  );
  await page.route(
    new RegExp(`/api/v1/waivers/orgs/${orgId}/signatures\\?`),
    (route) => route.fulfill({ json: { items: signatures } }),
  );
  await page.route(
    `**/api/v1/waivers/orgs/${orgId}/${waiverId}/signatures`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        participantPersonId: string;
        signerPersonId: string | null;
        signerNameTyped: string;
        method: 'online_typed';
      };
      submittedSignerPersonId = body.signerPersonId;
      const signature = {
        id: signatureId,
        waiverDocumentId: waiverId,
        documentVersion: 1,
        documentHash: 'a'.repeat(64),
        participantPersonId: body.participantPersonId,
        signerAccountId: actorId,
        signerPersonId: body.signerPersonId,
        signerNameTyped: body.signerNameTyped,
        method: body.method,
        signedAt: publishedAt,
      };
      signatures = [...signatures, signature];
      await route.fulfill({ status: 201, json: signature });
    },
  );
  await page.goto(`/me/family/${orgId}/${personId}/waivers`);
  return () => submittedSignerPersonId;
}

test('adult participant completes a waiver after a guardian signs', async ({
  page,
}) => {
  const existingGuardianSignature = {
    id: '88888888-8888-4888-8888-888888888888',
    waiverDocumentId: waiverId,
    documentVersion: 1,
    documentHash: 'b'.repeat(64),
    participantPersonId: personId,
    signerAccountId: '66666666-6666-4666-8666-666666666666',
    signerPersonId: null,
    signerNameTyped: 'Morgan Guardian',
    method: 'online_typed',
    signedAt: publishedAt,
  };
  const getSubmittedSignerPersonId = await setupDualSignerWaiver(page, {
    age: 25,
    relationship: 'self',
    signatures: [existingGuardianSignature],
  });
  await expect(page.getByText(/All required signatures/)).toHaveCount(0);
  await page.getByLabel('Type your full legal name').fill('Avery Athlete');
  await page.getByRole('button', { name: 'I have read and agree' }).click();
  await expect(
    page.getByText(/All required signatures are complete/),
  ).toBeVisible();
  expect(getSubmittedSignerPersonId()).toBe(personId);
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('verified guardian completes a waiver after the adult participant signs', async ({
  page,
}) => {
  const existingParticipantSignature = {
    id: '88888888-8888-4888-8888-888888888888',
    waiverDocumentId: waiverId,
    documentVersion: 1,
    documentHash: 'b'.repeat(64),
    participantPersonId: personId,
    signerAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
    signerPersonId: personId,
    signerNameTyped: 'Avery Athlete',
    method: 'online_typed',
    signedAt: publishedAt,
  };
  const getSubmittedSignerPersonId = await setupDualSignerWaiver(page, {
    age: 25,
    relationship: 'guardian',
    signatures: [existingParticipantSignature],
  });
  await expect(page.getByText(/All required signatures/)).toHaveCount(0);
  await page.getByLabel('Type your full legal name').fill('Morgan Guardian');
  await page.getByRole('button', { name: 'I have read and agree' }).click();
  await expect(
    page.getByText(/All required signatures are complete/),
  ).toBeVisible();
  expect(getSubmittedSignerPersonId()).toBeNull();
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('a guardian cannot sign a dual-signer waiver for a minor', async ({
  page,
}) => {
  await setupDualSignerWaiver(page, {
    age: 14,
    relationship: 'guardian',
    signatures: [],
  });
  await expect(page.getByText(/cannot be used for a minor/)).toBeVisible();
  await expect(page.getByLabel('Type your full legal name')).toHaveCount(0);
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('family member uploads a restricted document on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let uploaded = false;
  await page.route('**/api/v1/auth/me', async (route) =>
    route.fulfill({
      json: {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'guardian@example.invalid',
        firstName: 'Morgan',
        lastName: 'Guardian',
        locale: 'en',
        mfaEnabled: false,
        sessionId: '77777777-7777-4777-8777-777777777777',
        client: 'web',
      },
    }),
  );
  await page.route(
    `**/api/v1/people/orgs/${orgId}/${personId}/family-documents`,
    (route) =>
      route.fulfill({
        json: {
          items: uploaded
            ? [
                {
                  id: fileId,
                  mime: 'image/jpeg',
                  bytes: 1024,
                  uploadedAt: publishedAt,
                },
              ]
            : [],
        },
      }),
  );
  await page.route('**/api/v1/files/uploads', (route) =>
    route.fulfill({
      json: {
        fileId,
        uploadUrl: `/api/v1/files/uploads/${fileId}/content`,
      },
    }),
  );
  await page.route(
    `**/api/v1/files/uploads/${fileId}/content`,
    async (route) => {
      uploaded = true;
      await route.fulfill({ status: 204, body: '' });
    },
  );
  await page.route(`**/api/v1/files/uploads/${fileId}/complete`, (route) =>
    route.fulfill({ json: { id: fileId } }),
  );

  await page.goto(`/me/family/${orgId}/${personId}/documents`);
  await page
    .getByLabel('Choose a PDF, JPEG, or PNG file')
    .setInputFiles('server/test/fixtures/gps-photo.jpg');
  await expect(page.getByText('image/jpeg')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open document' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('guardian grants photo consent and crops a family profile photo on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let profile = {
    id: personId,
    orgId,
    firstName: 'Maya',
    lastName: 'Guardian',
    preferredName: null,
    dateOfBirth: '2012-01-01',
    graduationYear: null,
    age: 14,
    grade: null,
    gender: 'female',
    email: null,
    phoneE164: null,
    mediaConsent: 'unknown',
    photoFileId: null as string | null,
    status: 'active',
    version: 1,
    canEdit: true,
  };
  let uploadedJpegBytes = 0;
  let uploadContentType = '';
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'guardian@example.invalid',
        firstName: 'Morgan',
        lastName: 'Guardian',
        locale: 'en',
        mfaEnabled: false,
        sessionId: '77777777-7777-4777-8777-777777777777',
        client: 'web',
      },
    }),
  );
  await page.route(
    `**/api/v1/people/orgs/${orgId}/${personId}/family-profile`,
    async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: profile });
        return;
      }
      const body = route.request().postDataJSON() as {
        expectedVersion: number;
        mediaConsent: 'granted' | 'denied' | 'unknown';
      };
      expect(body.expectedVersion).toBe(profile.version);
      expect(body.mediaConsent).toBe('granted');
      profile = {
        ...profile,
        mediaConsent: body.mediaConsent,
        version: profile.version + 1,
      };
      await route.fulfill({ json: profile });
    },
  );
  await page.route('**/api/v1/files/uploads', async (route) => {
    const body = route.request().postDataJSON() as {
      mime: string;
      bytes: number;
      ownerType: string;
      ownerId: string;
      sensitivity: string;
    };
    expect(body).toMatchObject({
      mime: 'image/jpeg',
      ownerType: 'person',
      ownerId: personId,
      sensitivity: 'sensitive',
    });
    uploadedJpegBytes = body.bytes;
    await route.fulfill({
      json: {
        fileId,
        uploadUrl: `/api/v1/files/uploads/${fileId}/content`,
      },
    });
  });
  await page.route(
    `**/api/v1/files/uploads/${fileId}/content`,
    async (route) => {
      expect(route.request().method()).toBe('PUT');
      uploadContentType = route.request().headers()['content-type'] ?? '';
      await route.fulfill({ status: 204, body: '' });
    },
  );
  await page.route(`**/api/v1/files/uploads/${fileId}/complete`, (route) =>
    route.fulfill({ json: { id: fileId } }),
  );
  await page.route(
    `**/api/v1/people/orgs/${orgId}/${personId}/family-photo`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        expectedVersion: number;
        fileId: string;
      };
      expect(body).toEqual({ expectedVersion: profile.version, fileId });
      profile = {
        ...profile,
        photoFileId: fileId,
        version: profile.version + 1,
      };
      const person = Object.fromEntries(
        Object.entries(profile).filter(([key]) => key !== 'canEdit'),
      );
      await route.fulfill({ json: person });
    },
  );
  await page.route(`**/api/v1/files/${fileId}/download`, (route) =>
    route.fulfill({
      json: {
        url: `/api/v1/files/${fileId}/content`,
      },
    }),
  );
  await page.route(`**/api/v1/files/${fileId}/content`, (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n9sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );

  await page.goto(`/me/family/${orgId}/${personId}/profile`);
  await expect(
    page.getByRole('heading', { name: 'Maya Guardian' }),
  ).toBeVisible();
  await page.getByLabel('Media consent').selectOption('granted');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await page
    .getByLabel('Choose photo')
    .setInputFiles('server/test/fixtures/gps-photo.jpg');
  await expect(
    page.getByRole('img', { name: 'Photo crop preview' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Crop and upload photo' }),
  ).toBeEnabled();
  await page.getByLabel('Crop left or right').fill('70');
  await page.getByLabel('Zoom crop').fill('1.5');
  await page.getByRole('button', { name: 'Crop and upload photo' }).click();
  await expect(page.getByRole('img', { name: 'Maya Guardian' })).toBeVisible();
  expect(uploadedJpegBytes).toBeGreaterThan(0);
  expect(uploadContentType).toBe('image/jpeg');
  expect(await accessibilityViolations(page)).toEqual([]);
});
