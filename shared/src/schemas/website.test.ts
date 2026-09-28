import { describe, expect, it } from 'vitest';

import { websitePageBodySchema } from './website';

describe('website page content', () => {
  it('accepts accessible structured text blocks and safe links', () => {
    expect(
      websitePageBodySchema.safeParse({
        slug: 'about/our-club',
        title: 'About our club',
        blocks: [
          { type: 'heading', text: 'A place to play', level: 2 },
          { type: 'paragraph', text: 'Programs for every age group.' },
          { type: 'link', label: 'View programs', href: '/programs' },
        ],
        seo: { title: '', description: '', canonicalPath: '' },
        status: 'draft',
      }).success,
    ).toBe(true);
  });

  it('rejects script links and remote HTTP links', () => {
    for (const href of ['javascript:alert(1)', 'http://example.com']) {
      expect(
        websitePageBodySchema.safeParse({
          slug: 'about',
          title: 'About',
          blocks: [{ type: 'link', label: 'Bad link', href }],
          seo: { title: '', description: '', canonicalPath: '' },
          status: 'draft',
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a canonical path that can escape the site origin', () => {
    expect(
      websitePageBodySchema.safeParse({
        slug: 'about',
        title: 'About',
        blocks: [],
        seo: { title: '', description: '', canonicalPath: '//bad.example' },
        status: 'draft',
      }).success,
    ).toBe(false);
  });
});
