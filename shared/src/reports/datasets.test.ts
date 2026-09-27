import { describe, expect, it } from 'vitest';

import { canExportTier, REPORT_DATASETS } from './datasets';

describe('report dataset catalog', () => {
  it('has unique dataset and column keys', () => {
    expect(new Set(REPORT_DATASETS.map((dataset) => dataset.key)).size).toBe(
      REPORT_DATASETS.length,
    );
    for (const dataset of REPORT_DATASETS) {
      const keys = dataset.columns.map((column) => column.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('only exposes background-check status and non-sensitive context', () => {
    const dataset = REPORT_DATASETS.find(
      (candidate) => candidate.key === 'background_checks',
    );
    expect(dataset?.columns.map((column) => column.key)).toEqual([
      'id',
      'person_name',
      'provider',
      'status',
      'completed_at',
      'created_at',
    ]);
  });

  it('requires step-up for sensitive exports and blocks reporter exports', () => {
    expect(canExportTier(['finance'], 'sensitive', false)).toBe(false);
    expect(canExportTier(['finance'], 'sensitive', true)).toBe(true);
    expect(canExportTier(['reporter'], 'sensitive', true)).toBe(false);
    expect(canExportTier(['reporter'], 'internal', false)).toBe(true);
  });
});
