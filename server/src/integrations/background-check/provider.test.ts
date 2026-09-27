import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CheckrBackgroundCheckProvider,
  ManualBackgroundCheckProvider,
} from './provider';

describe('background-check providers', () => {
  it('supports manual officer recorded results', async () => {
    const provider = new ManualBackgroundCheckProvider();
    const created = await provider.create({
      candidateId: 'fixture',
      firstName: 'Test',
      lastName: 'Person',
      email: 'test@example.test',
      package: 'basic',
    });
    expect(created.status).toBe('pending');
    expect(
      provider.recordResult(created.providerId, 'clear', '2026-01-01T00:00:00Z')
        .status,
    ).toBe('clear');
  });
  it('rejects a non-allow-listed Checkr host', () => {
    expect(
      () =>
        new CheckrBackgroundCheckProvider({
          apiKey: 'fixture',
          baseUrl: 'https://evil.example',
        }),
    ).toThrow('allow-listed');
  });
  it('parses recorded Checkr response fixture', async () => {
    const fixture = await readFile(
      fileURLToPath(new URL('./checkr-report.fixture.json', import.meta.url)),
      'utf8',
    );
    const provider = new CheckrBackgroundCheckProvider({
      apiKey: 'fixture',
      fetch: () => Promise.resolve(new Response(fixture)),
    });
    await expect(
      provider.retrieve('rpt_fixture_athlentry_001'),
    ).resolves.toMatchObject({
      status: 'clear',
      completedAt: '2026-01-15T18:30:00Z',
    });
  });
  it('creates a candidate and report using the configured Checkr API only', async () => {
    const requests: Array<{
      url: string;
      body: string;
      authorization: string | null;
    }> = [];
    const responses = [
      new Response('{"id":"cand_fixture"}', { status: 201 }),
      new Response('{"id":"rpt_fixture"}', { status: 201 }),
    ];
    const provider = new CheckrBackgroundCheckProvider({
      apiKey: 'fake-checkr-key',
      fetch: (input, init) => {
        requests.push({
          url:
            input instanceof Request
              ? input.url
              : input instanceof URL
                ? input.toString()
                : input,
          body: typeof init?.body === 'string' ? init.body : '',
          authorization: new Headers(init?.headers).get('authorization'),
        });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected fixture request');
        return Promise.resolve(response);
      },
    });
    await expect(
      provider.create({
        candidateId: 'candidate-fixture',
        firstName: 'Fixture',
        lastName: 'Person',
        email: 'person@example.test',
        package: 'volunteer_basic',
      }),
    ).resolves.toEqual({ providerId: 'rpt_fixture', status: 'pending' });
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.checkr.com/v1/candidates',
      'https://api.checkr.com/v1/reports',
    ]);
    expect(requests[0]?.authorization).toBe(
      `Basic ${Buffer.from('fake-checkr-key:').toString('base64')}`,
    );
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({
      candidate_id: 'cand_fixture',
      package: 'volunteer_basic',
    });
  });
});
