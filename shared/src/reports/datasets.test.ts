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

  it('provides volunteer completion reporting without exposing household data', () => {
    const dataset = REPORT_DATASETS.find(
      (candidate) => candidate.key === 'volunteers',
    );
    expect(dataset?.requiredTables).toEqual([
      'volunteer_signups',
      'volunteer_shifts',
      'volunteer_roles',
      'people',
    ]);
    expect(dataset?.columns.map((column) => column.key)).toEqual([
      'id',
      'status',
      'hours_credited',
      'shift_starts_at',
      'role_name',
      'person_name',
    ]);
    expect(dataset?.columns.every((column) => column.tier === 'internal')).toBe(
      true,
    );
  });

  it('keeps aid details and uniform reports on the intended source fields', () => {
    const aidAwards = REPORT_DATASETS.find(
      (candidate) => candidate.key === 'aid_awards',
    );
    expect(aidAwards?.columns.map((column) => column.key)).toEqual([
      'id',
      'program_name',
      'status',
      'award_cents',
      'requested_cents',
      'created_at',
    ]);
    expect(
      aidAwards?.columns.find((column) => column.key === 'award_cents'),
    ).toMatchObject({ tier: 'sensitive', type: 'money' });

    const uniformSizes = REPORT_DATASETS.find(
      (candidate) => candidate.key === 'uniform_sizes',
    );
    expect(uniformSizes?.requiredTables).toContain('store_order_lines');
    expect(uniformSizes?.columns.map((column) => column.key)).toEqual([
      'id',
      'product_name',
      'product_kind',
      'size',
      'color',
      'quantity',
      'order_status',
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
