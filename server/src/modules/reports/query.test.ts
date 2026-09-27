import { reportDefinitionSchema } from '@shared/schemas/reports';
import { describe, expect, it } from 'vitest';

import {
  columnsForActor,
  datasetForActor,
  ReportError,
  reportUsesRestrictedColumns,
  resolveColumns,
  validateReportDefinition,
} from './query';

describe('report dataset access', () => {
  it('keeps medical columns out of the registrar report catalog', () => {
    const dataset = datasetForActor('people', ['registrar']);
    const visible = columnsForActor(dataset, ['registrar']);

    expect(visible.map((column) => column.key)).not.toContain('allergy_flags');
    expect(() =>
      resolveColumns(dataset, visible, {
        dataset: 'people',
        columns: ['allergy_flags'],
        filters: [],
        groupBy: [],
        aggregates: [],
        sort: [],
      }),
    ).toThrow(ReportError);
  });

  it('allows finance to use money datasets and hides them from registrars', () => {
    expect(datasetForActor('payments', ['finance']).key).toBe('payments');
    expect(() => datasetForActor('payments', ['registrar'])).toThrow(
      ReportError,
    );
  });

  it('validates filter values against the selected column type', () => {
    const dataset = datasetForActor('people', ['registrar']);
    const visible = columnsForActor(dataset, ['registrar']);
    const valid = reportDefinitionSchema.parse({
      dataset: 'people',
      columns: ['first_name'],
      filters: [{ column: 'first_name', op: 'contains', value: 'Dana' }],
    });
    const invalid = reportDefinitionSchema.parse({
      dataset: 'people',
      columns: ['graduation_year'],
      filters: [{ column: 'graduation_year', op: 'eq', value: '2030' }],
    });

    expect(() => {
      validateReportDefinition(dataset, visible, valid);
    }).not.toThrow();
    expect(() => {
      validateReportDefinition(dataset, visible, invalid);
    }).toThrow('Filter value does not match its column type');
  });

  it('tracks restricted columns used by any report operation', () => {
    const dataset = datasetForActor('people', ['compliance']);
    const definition = reportDefinitionSchema.parse({
      dataset: 'people',
      columns: ['first_name'],
      filters: [{ column: 'allergy_flags', op: 'not_null' }],
    });

    expect(reportUsesRestrictedColumns(dataset, definition)).toEqual([
      'allergy_flags',
    ]);
  });
});
