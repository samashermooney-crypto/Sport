import { describe, expect, it } from 'vitest';

import authEn from '../i18n/en/auth.json';
import platformEn from '../i18n/en/platform.json';
import portalEn from '../i18n/en/portal.json';
import siteEn from '../i18n/en/site.json';
import authEs from '../i18n/es/auth.json';
import platformEs from '../i18n/es/platform.json';
import portalEs from '../i18n/es/portal.json';
import siteEs from '../i18n/es/site.json';

function missingTranslations(
  english: unknown,
  spanish: unknown,
  path = '',
): string[] {
  if (typeof english !== 'object' || english === null || Array.isArray(english))
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
  it('provides Spanish values for every English auth, portal, platform, and site key', () => {
    expect({
      auth: missingTranslations(authEn, authEs),
      portal: missingTranslations(portalEn, portalEs),
      platform: missingTranslations(platformEn, platformEs),
      site: missingTranslations(siteEn, siteEs),
    }).toEqual({ auth: [], portal: [], platform: [], site: [] });
  });
});
