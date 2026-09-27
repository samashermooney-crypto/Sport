import { describe, expect, it } from 'vitest';

import { structuredLogRecord } from './logging';

describe('structured operational logs', () => {
  it('serializes only bounded operational metadata', () => {
    const record = structuredLogRecord(
      'warn',
      'queue.backlog',
      {
        requestId: 'req_0123456789',
        operation: 'retry.dispatch',
        module: 'communications',
        statusCode: 503,
        durationMs: 18.5,
        count: 1200,
        result: 'failed',
      },
      new Date('2026-09-27T15:00:00.000Z'),
    );
    expect(JSON.parse(record) as unknown).toEqual({
      timestamp: '2026-09-27T15:00:00.000Z',
      level: 'warn',
      event: 'queue.backlog',
      requestId: 'req_0123456789',
      operation: 'retry.dispatch',
      module: 'communications',
      statusCode: 503,
      durationMs: 18.5,
      count: 1200,
      result: 'failed',
    });
  });

  it('drops invalid identifiers and rejects free-text event names', () => {
    const record = structuredLogRecord('error', 'database.unavailable', {
      requestId: 'parent@example.test',
      operation: 'child has allergy',
      module: 'finance',
      count: -1,
    });
    expect(record).not.toContain('parent@example.test');
    expect(record).not.toContain('allergy');
    expect(record).not.toContain('count');
    expect(() => structuredLogRecord('error', 'child asthma')).toThrow();
  });
});
