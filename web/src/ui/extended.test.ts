import { describe, expect, it } from 'vitest';

import { sanitizeRichHtml } from './extended';

describe('rich text allow-list', () => {
  it('keeps supported formatting while removing executable markup and attributes', () => {
    const sanitized = sanitizeRichHtml(
      '<p onclick="alert(1)">Hello <strong>team</strong><script>alert(2)</script></p><a href="javascript:alert(3)" title="safe">link</a><img src="x" onerror="alert(4)">',
    );

    expect(sanitized).toContain('<p>Hello <strong>team</strong>alert(2)</p>');
    expect(sanitized).toContain('<a title="safe">link</a>');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('<img');
  });

  it('allows secure links and strips unsupported attributes', () => {
    expect(
      sanitizeRichHtml(
        '<a href="https://example.invalid" target="_blank">Site</a>',
      ),
    ).toBe('<a href="https://example.invalid">Site</a>');
  });
});
