import { describe, expect, it } from 'vitest';

import { notificationCatalog } from '../notifications/catalog';

import { moduleDefinition } from './module';
import { phase10NotificationTemplates } from './schema';

describe('Phase 10 notification catalog integration', () => {
  it('registers bilingual H templates against Track B notification type IDs', () => {
    const typeIds = Object.keys(phase10NotificationTemplates);
    expect(moduleDefinition.notificationTypes).toEqual(typeIds);

    for (const typeId of typeIds) {
      const catalogEntry =
        notificationCatalog[typeId as keyof typeof notificationCatalog];
      const template =
        phase10NotificationTemplates[
          typeId as keyof typeof phase10NotificationTemplates
        ];
      expect(catalogEntry).toBeDefined();
      expect(catalogEntry.category).toBe(template.category);
      expect(template.en.title.length).toBeGreaterThan(0);
      expect(template.en.body.length).toBeGreaterThan(0);
      expect(template.es.title.length).toBeGreaterThan(0);
      expect(template.es.body.length).toBeGreaterThan(0);
    }
  });
});
