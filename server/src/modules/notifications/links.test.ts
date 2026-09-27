import { describe, expect, it } from 'vitest';

import { preferencesCenterPath } from './links';

describe('notification preferences-center link', () => {
  it('returns a tenant-scoped internal destination and rejects invalid ids', () => {
    expect(preferencesCenterPath('421ce0a0-3f91-47b1-a8b8-915ae5371225')).toBe(
      '/portal/orgs/421ce0a0-3f91-47b1-a8b8-915ae5371225/notifications#preferences',
    );
    expect(() => preferencesCenterPath('../other')).toThrow();
  });
});
