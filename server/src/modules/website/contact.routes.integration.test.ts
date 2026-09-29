import { createHash, randomUUID } from 'node:crypto';

import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { FakeEmailSender } from '../../integrations/email/sender';
import type { AuthDependencies } from '../auth/routes';

import { createWebsiteRouter } from './routes';

const orgId = randomUUID();
const orgSlug = `public-contact-${orgId.slice(0, 8)}`;
const inboxEmail = `contact-${orgId.slice(0, 8)}@example.invalid`;
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [orgId, orgSlug, 'Public Contact Test Club', 'club', 'UTC', 'active'],
    );
    await admin.query(
      'INSERT INTO website_settings(org_id,published,contact_inbox_email,theme) VALUES ($1,true,$2,$3)',
      [
        orgId,
        inboxEmail,
        JSON.stringify({ primary: '#3a67b2', secondary: '#252b2e' }),
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('public website contact route', () => {
  it('serves SEO policy and validates public contact submissions', async () => {
    let captchaValid = true;
    const captcha = {
      verify: (token: string) =>
        Promise.resolve(captchaValid && token.length > 0),
    };
    const email = new FakeEmailSender();
    const dependencies = {
      database,
      captcha,
      email,
      appUrl: 'http://localhost:3000',
      clock: () => new Date('2026-09-28T18:00:00.000Z'),
    } as unknown as AuthDependencies;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/website', createWebsiteRouter(dependencies));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('The test server did not open a TCP port');
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const robotsResponse = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/robots.txt`,
      );
      expect(robotsResponse.status).toBe(200);
      expect(robotsResponse.headers.get('content-type')).toContain(
        'text/plain',
      );
      expect(await robotsResponse.text()).toBe(
        [
          'User-agent: *',
          'Allow: /',
          `Sitemap: https://${orgSlug}.athlentry.com/api/v1/website/public/${orgSlug}/sitemap.xml`,
          '',
        ].join('\n'),
      );
      const sitemap = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/sitemap.xml`,
      );
      const sitemapXml = await sitemap.text();
      expect(sitemap.status).toBe(200);
      expect(sitemapXml).toContain(
        `https://${orgSlug}.athlentry.com/site/${orgSlug}/programs`,
      );
      expect(sitemapXml).toContain(
        `https://${orgSlug}.athlentry.com/site/${orgSlug}/schedule`,
      );

      const robotsAdmin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await robotsAdmin.connect();
      try {
        await robotsAdmin.query(
          "UPDATE website_settings SET robots_policy = 'noindex' WHERE org_id = $1",
          [orgId],
        );
      } finally {
        await robotsAdmin.end();
      }
      const noindexRobots = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/robots.txt`,
      );
      expect(await noindexRobots.text()).toBe('User-agent: *\nDisallow: /\n');
      const noindexSitemap = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/sitemap.xml`,
      );
      expect(await noindexSitemap.text()).not.toContain('<url>');

      const challenge = 'test-contact-token';
      const response = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/contact`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Morgan Parent',
            email: 'morgan@example.invalid',
            subject: 'Registration question',
            body: 'When does registration open?',
            captchaToken: challenge,
          }),
        },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ received: true });
      expect(email.messages).toHaveLength(1);
      expect(email.messages[0]).toMatchObject({
        to: inboxEmail,
        subject: 'Website contact form submission',
        replyTo: 'morgan@example.invalid',
        kind: 'transactional',
      });
      expect(email.messages[0]?.text).toContain('When does registration open?');

      const admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await admin.connect();
      try {
        const stored = await admin.query<{
          name: string;
          email: string;
          subject: string;
          body: string;
          turnstile_token: string;
        }>(
          'SELECT name, email, subject, body, turnstile_token FROM contact_submissions WHERE org_id = $1',
          [orgId],
        );
        expect(stored.rows).toEqual([
          {
            name: 'Morgan Parent',
            email: 'morgan@example.invalid',
            subject: 'Registration question',
            body: 'When does registration open?',
            turnstile_token: createHash('sha256')
              .update(challenge)
              .digest('hex'),
          },
        ]);
        expect(stored.rows[0]?.turnstile_token).not.toBe(challenge);
      } finally {
        await admin.end();
      }

      captchaValid = false;
      const rejected = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/contact`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bot',
            email: 'bot@example.invalid',
            body: 'Do not store this.',
            captchaToken: 'bad-token',
          }),
        },
      );
      expect(rejected.status).toBe(403);
      expect(email.messages).toHaveLength(1);

      captchaValid = true;
      const formResponse = await fetch(
        `${origin}/api/v1/website/public/${orgSlug}/contact`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            name: 'Taylor Guardian',
            email: 'taylor@example.invalid',
            subject: '',
            body: 'A public HTML form message.',
            'cf-turnstile-response': 'form-challenge',
          }),
          redirect: 'manual',
        },
      );
      expect(formResponse.status).toBe(303);
      expect(formResponse.headers.get('location')).toBe(
        `/site/${orgSlug}/contact?sent=1`,
      );
      expect(email.messages).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
