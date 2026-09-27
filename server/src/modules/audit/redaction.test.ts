import { describe, expect, it } from 'vitest';

import { redactAuditChanges, redactStoredChanges } from './redaction';

describe('audit redaction', () => {
  it('replaces Restricted before and after values', () => {
    expect(
      redactAuditChanges({
        status: { tier: 'internal', before: 'pending', after: 'active' },
        'medical.notes': {
          tier: 'restricted',
          before: 'allergy',
          after: 'treatment',
        },
      }),
    ).toEqual({
      status: { tier: 'internal', before: 'pending', after: 'active' },
      'medical.notes': {
        tier: 'restricted',
        before: '[redacted]',
        after: '[redacted]',
      },
    });
  });

  it('fails closed on unknown legacy shapes', () => {
    expect(redactStoredChanges({ unknown: { before: 'secret' } })).toEqual({
      unknown: '[redacted]',
    });
    expect(
      redactStoredChanges({ notes: { tier: 'restricted', after: 'private' } }),
    ).toEqual({ notes: { tier: 'restricted', after: '[redacted]' } });
  });
});
