import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export async function accessibilityViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter(
      (violation) =>
        violation.impact === 'serious' || violation.impact === 'critical',
    )
    .map((violation) => `${violation.id}: ${violation.description}`);
}
