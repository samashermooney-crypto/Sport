import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

import { localPorts } from '../scripts/ports.mjs';

const { Client } = pg;
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const ports = localPorts();
const orgId = '71000000-0000-7000-8000-000000000001';
const sportProfileId = '71000000-0000-7000-8000-000000000002';
const seasonId = '71000000-0000-7000-8000-000000000003';
const programId = '71000000-0000-7000-8000-000000000004';
const offeringId = '71000000-0000-7000-8000-000000000005';
const eventId = '71000000-0000-7000-8000-000000000006';
const pageId = '71000000-0000-7000-8000-000000000007';
const orgSlug = 'lighthouse-phase14';
const apiOrigin = `http://127.0.0.1:${String(ports.api)}`;
const resultsDirectory = resolve(
  process.env.LIGHTHOUSE_RESULTS_DIR ?? 'perf/results/phase14-shared-app',
);
const lighthouseCli = resolve('node_modules/lighthouse/cli/index.js');
const server = spawn(process.execPath, ['scripts/dev.mjs'], {
  env: {
    ...process.env,
    COMPOSE_PROJECT_NAME:
      process.env.COMPOSE_PROJECT_NAME ?? 'athlentry_d_lighthouse_ci',
  },
  stdio: 'inherit',
});
const serverExited = once(server, 'exit');
let proxy;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForApi() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`Dev server exited with code ${String(server.exitCode)}`);
    try {
      const response = await fetch(`${apiOrigin}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The database migration and API listener may still be starting.
    }
    await sleep(500);
  }
  throw new Error(`API did not become ready at ${apiOrigin}/readyz`);
}

async function seedPublicSite() {
  const port = Number(process.env.ATHLENTRY_POSTGRES_PORT ?? ports.postgres);
  const connectionString =
    process.env.DATABASE_ADMIN_URL ??
    `postgres://athlentry_admin@127.0.0.1:${String(port)}/athlentry_dev`;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO organizations(id, slug, name, kind, timezone, status)
       VALUES ($1, $2, 'Phase 14 Lighthouse Club', 'club', 'UTC', 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
      [orgId, orgSlug],
    );
    await client.query(
      `INSERT INTO sport_profiles(id, org_id, name, profile)
       VALUES ($1, $2, 'Soccer', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [sportProfileId, orgId],
    );
    await client.query(
      `INSERT INTO seasons(id, org_id, name, starts_on, ends_on, status)
       VALUES ($1, $2, 'Fall 2026', CURRENT_DATE - 7, CURRENT_DATE + 60, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [seasonId, orgId],
    );
    await client.query(
      `INSERT INTO programs(
         id, org_id, season_id, sport_profile_id, mode, name, slug,
         status, visibility, starts_on, ends_on
       ) VALUES (
         $1, $2, $3, $4, 'league', 'Community Soccer', 'community-soccer',
         'registration_open', 'public', CURRENT_DATE - 7, CURRENT_DATE + 60
       ) ON CONFLICT (id) DO NOTHING`,
      [programId, orgId, seasonId, sportProfileId],
    );
    await client.query(
      `INSERT INTO registration_offerings(
         id, org_id, program_id, name, registrant_role, visibility, active
       ) VALUES ($1, $2, $3, 'Player registration', 'athlete', 'public', true)
       ON CONFLICT (id) DO NOTHING`,
      [offeringId, orgId, programId],
    );
    await client.query(
      `INSERT INTO events(
         id, org_id, program_id, kind, title, starts_at, ends_at,
         timezone, location_text, published
       ) VALUES (
         $1, $2, $3, 'game', 'Community Soccer Opener',
         CURRENT_DATE + 14 + TIME '15:00',
         CURRENT_DATE + 14 + TIME '16:00',
         'UTC', 'North Park Field 1', true
       ) ON CONFLICT (id) DO NOTHING`,
      [eventId, orgId, programId],
    );
    await client.query(
      `INSERT INTO website_pages(
         id, org_id, slug, title, status, blocks, seo, published_at
       ) VALUES (
         $1, $2, 'home', 'Community Soccer', 'published',
         '[{"type":"paragraph","text":"A welcoming place to play and grow."}]'::jsonb,
         '{"title":"Community Soccer","description":"Youth soccer for every family.","canonicalPath":""}'::jsonb,
         now()
       ) ON CONFLICT (id) DO NOTHING`,
      [pageId, orgId],
    );
    await client.query(
      `INSERT INTO website_settings(org_id, published, theme, home_page_id)
       VALUES ($1, true, '{"primary":"#3a67b2","secondary":"#252b2e"}'::jsonb, $2)
       ON CONFLICT (org_id) DO UPDATE SET
         published = true, theme = EXCLUDED.theme, home_page_id = EXCLUDED.home_page_id`,
      [orgId, pageId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function createSiteProxy() {
  const siteCss = await readFile(resolve('public/site.css'));
  proxy = createServer((request, response) => {
    if (request.url === '/site.css') {
      response.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
      response.end(siteCss);
      return;
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: ports.api,
        path: request.url ?? '/',
        method: request.method,
        headers: {
          ...request.headers,
          host: `${orgSlug}.athlentry.com`,
        },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string')
    throw new Error('The Lighthouse site proxy did not open a TCP port');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function auditRoute(origin, name, route) {
  const outputPath = resolve(resultsDirectory, `${name}.json`);
  const cli = spawn(
    process.execPath,
    [
      lighthouseCli,
      `${origin}${route}`,
      '--output=json',
      `--output-path=${outputPath}`,
      '--only-categories=performance,accessibility,seo',
      '--form-factor=mobile',
      '--throttling-method=simulate',
      '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage',
      '--quiet',
    ],
    {
      env: { ...process.env, CHROME_PATH: chromium.executablePath() },
      stdio: 'inherit',
    },
  );
  const [code] = await once(cli, 'exit');
  if (code !== 0)
    throw new Error(`Lighthouse failed for ${route} with code ${String(code)}`);

  const result = JSON.parse(await readFile(outputPath, 'utf8'));
  const scores = {
    performance: Math.round((result.categories.performance.score ?? 0) * 100),
    accessibility: Math.round(
      (result.categories.accessibility.score ?? 0) * 100,
    ),
    seo: Math.round((result.categories.seo.score ?? 0) * 100),
  };
  const targets = { performance: 90, accessibility: 100, seo: 95 };
  const failures = Object.entries(targets).filter(
    ([category, target]) => scores[category] < target,
  );
  process.stdout.write(
    `${route}: Performance ${String(scores.performance)}, Accessibility ${String(scores.accessibility)}, SEO ${String(scores.seo)}\n`,
  );
  if (failures.length) {
    throw new Error(
      `${route} missed Lighthouse targets: ${failures.map(([category, target]) => `${category} ${String(scores[category])}/${String(target)}`).join(', ')}`,
    );
  }
  return { name, route, scores, targets };
}

async function main() {
  await mkdir(resultsDirectory, { recursive: true });
  await waitForApi();
  await seedPublicSite();
  const origin = await createSiteProxy();
  const audits = [];
  for (const [name, route, expectedContent] of [
    ['home', `/site/${orgSlug}`, 'Community Soccer'],
    ['programs', `/site/${orgSlug}/programs`, 'Community Soccer'],
    ['schedule', `/site/${orgSlug}/schedule`, 'Community Soccer Opener'],
  ]) {
    const response = await fetch(`${origin}${route}`);
    const html = await response.text();
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('text/html') ||
      !html.includes(expectedContent)
    ) {
      throw new Error(
        `Shared-app SSR route ${route} returned ${String(response.status)} without its expected public content`,
      );
    }
    audits.push(await auditRoute(origin, name, route));
  }
  const summary = [
    '# Phase 14 shared-app Lighthouse results',
    '',
    `Captured ${new Date().toISOString()} with Lighthouse 13.5.0 and Playwright Chromium.`,
    '',
    'Each route is served by the registered public website router in `createApp`; the local proxy serves the same `public/site.css` asset and forwards all page and SEO requests to the app.',
    '',
    '| Route | Performance | Accessibility | SEO |',
    '| --- | ---: | ---: | ---: |',
    ...audits.map(
      ({ name, scores }) =>
        `| ${name} | ${String(scores.performance)} | ${String(scores.accessibility)} | ${String(scores.seo)} |`,
    ),
    '',
    'Targets: Performance ≥ 90, Accessibility 100, SEO ≥ 95.',
    '',
  ].join('\n');
  await writeFile(resolve(resultsDirectory, 'README.md'), summary);
}

try {
  await main();
} finally {
  if (proxy?.listening) {
    proxy.close();
    await once(proxy, 'close');
  }
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    const stopped = await Promise.race([
      serverExited.then(() => true),
      sleep(20_000).then(() => false),
    ]);
    if (!stopped) {
      server.kill('SIGKILL');
      await serverExited;
    }
  }
}
