import { describe, expect, it } from 'vitest';

import { publicStatus, readinessResponse } from './health';

describe('public operational status', () => {
  it('returns only component state and no operational measurements', () => {
    const result = publicStatus({ api: true, database: false, worker: true });
    expect(result).toEqual({
      status: 'degraded',
      components: {
        api: 'operational',
        database: 'degraded',
        worker: 'operational',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /tenant|count|provider|message|error/i,
    );
  });

  it('makes database readiness explicit', () => {
    expect(readinessResponse(true)).toEqual({ ready: true });
    expect(readinessResponse(false)).toEqual({ ready: false });
  });
});
