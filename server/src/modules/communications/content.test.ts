import { describe, expect, it } from 'vitest';

import {
  htmlToText,
  renderMergeFields,
  sanitizeCampaignHtml,
  smsSegmentCount,
} from './content';
import { createUnsubscribeToken, verifyUnsubscribeToken } from './delivery';

describe('communications content rendering', () => {
  it('renders supported merge fields with fallbacks and drops unknown tokens', () => {
    expect(
      renderMergeFields(
        'Hi {{guardian.first_name}} {{event.next.start}} {{bad.field}}',
        {
          'guardian.first_name': 'Rae',
          'event.next.start': null,
        },
      ),
    ).toBe('Hi Rae  ');
    expect(renderMergeFields('{{athlete.first_name|Athlete}}', {})).toBe(
      'Athlete',
    );
    expect(
      renderMergeFields(
        '{{guardian.first_name}}',
        { 'guardian.first_name': '<Rae>' },
        true,
      ),
    ).toBe('&lt;Rae&gt;');
  });

  it('keeps campaign HTML to safe email markup and derives readable text', () => {
    const html = sanitizeCampaignHtml(
      '<p>Hello <strong>team</strong></p><script>alert(1)</script><a href="javascript:alert(1)">bad</a>',
      'https://athlentry.test',
    );
    expect(html).toContain('<p>Hello <strong>team</strong></p>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('javascript:');
    expect(htmlToText(html)).toContain('Hello team');
  });

  it('calculates GSM and Unicode concatenated SMS segments', () => {
    expect(smsSegmentCount('a'.repeat(160))).toBe(1);
    expect(smsSegmentCount('a'.repeat(161))).toBe(2);
    expect(smsSegmentCount('😀'.repeat(36))).toBe(2);
  });

  it('signs category-scoped unsubscribe tokens and rejects expired tokens', () => {
    const claims = {
      orgId: '00000000-0000-4000-8000-000000000001',
      accountId: '00000000-0000-4000-8000-000000000002',
      category: 'announcement' as const,
      channel: 'email' as const,
      expiresAt: 1_800_000_000,
    };
    const token = createUnsubscribeToken(
      claims,
      'test-signing-secret-at-least-32-bytes-long',
    );
    expect(
      verifyUnsubscribeToken(
        token,
        new Date('2026-09-27T00:00:00Z'),
        'test-signing-secret-at-least-32-bytes-long',
      ),
    ).toMatchObject(claims);
    expect(() =>
      verifyUnsubscribeToken(
        token,
        new Date('2030-01-01T00:00:00Z'),
        'test-signing-secret-at-least-32-bytes-long',
      ),
    ).toThrow('expired or invalid');
    const invalidCategory = {
      ...claims,
      category: 'emergency',
    } as unknown as Parameters<typeof createUnsubscribeToken>[0];
    expect(() =>
      createUnsubscribeToken(
        invalidCategory,
        'test-signing-secret-at-least-32-bytes-long',
      ),
    ).toThrow('cannot be unsubscribed');
  });
});
