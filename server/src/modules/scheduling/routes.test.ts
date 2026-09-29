import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthDependencies } from '../auth/routes';

import { createSchedulingRouter } from './routes';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listEvents: vi.fn(),
  getCalendarFeed: vi.fn(),
}));

vi.mock('../auth/routes', () => ({
  requireSession: mocks.requireSession,
}));

vi.mock('./events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./events')>()),
  getCalendarFeed: mocks.getCalendarFeed,
  listEvents: mocks.listEvents,
}));

const orgId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const eventId = '00000000-0000-4000-8000-000000000003';

let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ accountId });
  mocks.listEvents.mockReset();
  mocks.listEvents.mockResolvedValue([{ id: eventId }]);
  mocks.getCalendarFeed.mockReset();
  mocks.getCalendarFeed.mockResolvedValue(
    'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  );

  const app = express();
  app.use(
    createSchedulingRouter({
      appUrl: 'https://athlentry.example',
    } as AuthDependencies),
  );
  const listener = await new Promise<Server>((resolve, reject) => {
    const opened = app.listen(0, '127.0.0.1', () => {
      resolve(opened);
    });
    opened.once('error', reject);
  });
  server = listener;
  const address = listener.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  if (!server) return;
  const listener = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe('scheduling HTTP routes', () => {
  it('lists events with validated filters and safe response headers', async () => {
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-11-01T00:00:00.000Z';
    const programId = '00000000-0000-4000-8000-000000000004';
    const teamSeasonId = '00000000-0000-4000-8000-000000000005';
    const query = new URLSearchParams({
      from,
      to,
      programId,
      teamSeasonId,
      includeDrafts: 'true',
    });

    const response = await fetch(`${baseUrl}/orgs/${orgId}/events?${query}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toEqual({
      items: [{ id: eventId }],
    });
    expect(mocks.requireSession).toHaveBeenCalledOnce();
    expect(mocks.listEvents).toHaveBeenCalledWith(
      { orgId, actor: { accountId } },
      {
        from: new Date(from),
        to: new Date(to),
        programId,
        teamSeasonId,
        includeDrafts: true,
      },
    );
  });

  it('serves private calendar feeds without cache or referrer leakage', async () => {
    const token = 'a'.repeat(43);
    const response = await fetch(`${baseUrl}/orgs/${orgId}/feeds/${token}.ics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.text()).resolves.toBe(
      'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    );
    expect(mocks.getCalendarFeed).toHaveBeenCalledWith(
      { orgId, actor: { accountId: '00000000-0000-7000-8000-000000000000' } },
      token,
    );
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });

  it('rejects mutations from an unverified request origin before session lookup', async () => {
    const response = await fetch(`${baseUrl}/orgs/${orgId}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        'x-athlentry-request': '1',
      },
      body: '{}',
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'FORBIDDEN',
        message: 'Request origin could not be verified.',
      },
    });
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });
});
