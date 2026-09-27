import { describe, expect, it } from 'vitest';

import {
  parseExpectedVersion,
  requireVersion,
  VersionConflictError,
} from './version-check';

describe('optimistic version checks', () => {
  it('returns the current record when versions match', () => {
    const record = { id: 'a', version: 4 };
    expect(requireVersion(record, parseExpectedVersion(4))).toBe(record);
  });

  it('returns the current resource with a 409 conflict on stale updates', () => {
    const record = { id: 'a', version: 5 };
    try {
      requireVersion(record, 4);
      throw new Error('Expected version conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error).toMatchObject({
        status: 409,
        code: 'CONFLICT',
        current: record,
      });
    }
    expect(() => parseExpectedVersion(0)).toThrow();
  });
});
