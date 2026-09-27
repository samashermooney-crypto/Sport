import { describe, expect, it } from 'vitest';

import { scrubSentryBreadcrumb, scrubSentryEvent } from './privacy';
import { initSentry } from './sentry';

describe('Sentry privacy boundary', () => {
  it('keeps allowlisted diagnostic metadata and drops family and request data', () => {
    const event = scrubSentryEvent({
      event_id: 'a'.repeat(32),
      platform: 'node',
      environment: 'production',
      level: 'error',
      message: 'guardian parent@example.test child has asthma',
      request: { url: '/api/v1/people/person-id?email=parent@example.test' },
      user: { email: 'parent@example.test', ip_address: '192.0.2.2' },
      extra: { medical: 'asthma', body: 'private content' },
      tags: {
        module: 'registration',
        personId: 'child-id',
        'http.method': 'POST',
      },
      exception: {
        values: [
          {
            type: 'ValidationError',
            value: 'parent@example.test child birth date 2015-03-04',
            stacktrace: {
              frames: [
                {
                  filename: 'server/src/modules/registration/service.ts',
                  function: 'submitCheckout',
                  lineno: 42,
                  colno: 3,
                  vars: { email: 'parent@example.test' },
                },
              ],
            },
          },
        ],
      },
    });

    expect(event).toMatchObject({
      event_id: 'a'.repeat(32),
      platform: 'node',
      environment: 'production',
      level: 'error',
      tags: { module: 'registration', 'http.method': 'POST' },
      exception: {
        values: [
          {
            type: 'ValidationError',
            value: '[redacted]',
            stacktrace: {
              frames: [
                {
                  filename: 'server/src/modules/registration/service.ts',
                  function: 'submitCheckout',
                  lineno: 42,
                  colno: 3,
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain('parent@example.test');
    expect(JSON.stringify(event)).not.toContain('asthma');
    expect(JSON.stringify(event)).not.toContain('person-id');
    expect(JSON.stringify(event)).not.toContain('birth date');
  });

  it('drops user-activity breadcrumbs and permits an unconfigured local SDK', () => {
    expect(scrubSentryBreadcrumb()).toBeNull();
    expect(initSentry({})).toBe(false);
  });
});
