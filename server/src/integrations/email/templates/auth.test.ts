import { describe, expect, it } from 'vitest';

import { emailTranslationCatalog } from './auth.js';

describe('Spanish email translation coverage', () => {
  it('provides a Spanish subject and body for every English template', () => {
    const english = emailTranslationCatalog.en;
    const spanish = emailTranslationCatalog.es;
    expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      expect(spanish[key]).toHaveLength(2);
      expect(spanish[key].every((value) => value.trim().length > 0)).toBe(true);
    }
  });
});
