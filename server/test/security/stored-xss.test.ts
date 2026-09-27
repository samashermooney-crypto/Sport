import { describe, expect, it } from 'vitest';

import { sanitizeCampaignHtml } from '../../src/modules/communications/content';

describe('stored rich-text output', () => {
  it('removes active content, event handlers and unsafe link schemes', () => {
    const stored = sanitizeCampaignHtml(
      '<p onclick="alert(1)">Roster</p><img src=x onerror="alert(2)"><svg onload="alert(3)"><script>alert(4)</script></svg><a href="javascript:alert(5)">details</a><a href="//attacker.invalid">external</a>',
      'https://athlentry.test',
    );

    expect(stored).toContain('<p>Roster</p>');
    expect(stored).toContain('<a>details</a>');
    expect(stored).toContain('<a>external</a>');
    expect(stored).not.toMatch(/<\s*(script|img|svg|iframe)\b/i);
    expect(stored).not.toMatch(/\bon(?:click|error|load)\s*=/i);
    expect(stored).not.toMatch(/javascript:|\/\/attacker\.invalid/i);
  });

  it('keeps only same-origin absolute links and safe relative links', () => {
    const stored = sanitizeCampaignHtml(
      '<a href="https://athlentry.test/rules?season=1#fees">rules</a><a href="/calendar">calendar</a><a href="data:text/html,boom">data</a>',
      'https://athlentry.test',
    );

    expect(stored).toContain('href="/rules?season=1#fees"');
    expect(stored).toContain('href="/calendar"');
    expect(stored).toContain('<a>data</a>');
  });
});
