import { describe, expect, it } from 'vitest';

import authEn from '../i18n/en/auth.json';
import consoleEn from '../i18n/en/console.json';
import platformEn from '../i18n/en/platform.json';
import portalEn from '../i18n/en/portal.json';
import publicEn from '../i18n/en/public.json';
import shellEn from '../i18n/en/shell.json';
import siteEn from '../i18n/en/site.json';
import authEs from '../i18n/es/auth.json';
import consoleEs from '../i18n/es/console.json';
import platformEs from '../i18n/es/platform.json';
import portalEs from '../i18n/es/portal.json';
import publicEs from '../i18n/es/public.json';
import shellEs from '../i18n/es/shell.json';
import siteEs from '../i18n/es/site.json';

function missingTranslations(
  english: unknown,
  spanish: unknown,
  path = '',
): string[] {
  if (typeof english === 'string') {
    return typeof spanish === 'string' && spanish.trim().length > 0
      ? []
      : [path];
  }
  if (Array.isArray(english)) {
    if (!Array.isArray(spanish)) return [path];
    return english.flatMap((value, index) =>
      missingTranslations(value, spanish[index], `${path}[${String(index)}]`),
    );
  }
  if (typeof english !== 'object' || english === null)
    return spanish === undefined ? [path] : [];
  const enRecord = english as Record<string, unknown>;
  const esRecord =
    typeof spanish === 'object' && spanish !== null && !Array.isArray(spanish)
      ? (spanish as Record<string, unknown>)
      : {};
  return Object.entries(enRecord).flatMap(([key, value]) =>
    missingTranslations(value, esRecord[key], path ? `${path}.${key}` : key),
  );
}

describe('Spanish translation coverage', () => {
  it('detects missing and blank nested translations', () => {
    expect(
      missingTranslations(
        { account: { email: 'Email', name: 'Name' } },
        { account: { email: '   ' } },
      ),
    ).toEqual(['account.email', 'account.name']);
  });

  it('provides Spanish values for every English UI translation key', () => {
    expect({
      auth: missingTranslations(authEn, authEs),
      console: missingTranslations(consoleEn, consoleEs),
      platform: missingTranslations(platformEn, platformEs),
      portal: missingTranslations(portalEn, portalEs),
      public: missingTranslations(publicEn, publicEs),
      shell: missingTranslations(shellEn, shellEs),
      site: missingTranslations(siteEn, siteEs),
    }).toEqual({
      auth: [],
      console: [],
      platform: [],
      portal: [],
      public: [],
      shell: [],
      site: [],
    });
  });
});
