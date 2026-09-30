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
  it('reports credential compliance against the inclusive current-date boundary', () => {
    const dataset = datasetForActor('credentials', ['compliance']);
    const visible = columnsForActor(dataset, ['compliance']);
    const compliance = dataset.columns.find(
      (column) => column.key === 'compliance_status',
    );
    const definition = reportDefinitionSchema.parse({
      dataset: 'credentials',
      columns: ['compliance_status'],
      filters: [{ column: 'status', op: 'ne', value: 'revoked' }],
      groupBy: ['compliance_status'],
      aggregates: [{ fn: 'count', column: 'id' }],
    });

    expect(compliance?.source).toContain('t.expires_on IS NULL');
    expect(compliance?.source).toContain('t.expires_on >= CURRENT_DATE');
    expect(compliance?.source).toContain(
      "WHEN t.status = 'verified' THEN 'expired'",
    );
    expect(() => {
      validateReportDefinition(dataset, visible, definition);
    }).not.toThrow();
  });

  it('exposes invoice aging buckets only through the finance dataset role', () => {
    const invoices = datasetForActor('invoices', ['finance']);
    const aging = invoices.columns.find(
      (column) => column.key === 'aging_bucket',
    );
    expect(aging?.type).toBe('enum');
    expect(aging?.source).toContain('CURRENT_DATE - 90');
    expect(aging?.source).toContain("ELSE '90+ days overdue'");
    expect(() => datasetForActor('invoices', ['registrar'])).toThrow(
      ReportError,
    );
  });

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

  it('offers payout reconciliation fields only to money-report roles', () => {
    const payouts = datasetForActor('payouts', ['finance']);
    expect(payouts.columns.map((column) => column.key)).toEqual([
      'id',
      'status',
      'amount_cents',
      'arrival_date',
    ]);
    expect(
      payouts.columns.find((column) => column.key === 'amount_cents'),
    ).toMatchObject({ tier: 'sensitive', type: 'money' });
    expect(() => datasetForActor('payouts', ['registrar'])).toThrow(
      ReportError,
    );
  });

  it('exposes evaluation results to directors with participant scores tiered as sensitive', () => {
    const dataset = datasetForActor('evaluation_results', ['director']);
    const visible = columnsForActor(dataset, ['director']);
    expect(
      dataset.columns.find((column) => column.key === 'composite_score'),
    ).toMatchObject({ tier: 'sensitive', type: 'number' });
    expect(visible.map((column) => column.key)).toContain('participant_name');
    expect(() => datasetForActor('evaluation_results', ['finance'])).toThrow(
      ReportError,
    );
  });

  it('limits aid awards to money roles and accepts award-state filters', () => {
    const dataset = datasetForActor('aid_awards', ['finance']);
    const visible = columnsForActor(dataset, ['finance']);
    const award = dataset.columns.find(
      (column) => column.key === 'award_cents',
    );
    const definition = reportDefinitionSchema.parse({
      dataset: 'aid_awards',
      columns: ['program_name'],
      filters: [
        {
          column: 'status',
          op: 'in',
          value: ['awarded', 'partially_awarded'],
        },
      ],
      groupBy: ['program_name'],
      aggregates: [{ fn: 'sum', column: 'award_cents' }],
    });

    expect(award).toMatchObject({ tier: 'sensitive', type: 'money' });
    expect(() => {
      validateReportDefinition(dataset, visible, definition);
    }).not.toThrow();
    expect(() => datasetForActor('aid_awards', ['registrar'])).toThrow(
      ReportError,
    );
  });

  it('keeps uniform reporting aggregated to product, size, and quantity', () => {
    const dataset = datasetForActor('uniform_sizes', ['finance']);
    const visible = columnsForActor(dataset, ['finance']);
    const definition = reportDefinitionSchema.parse({
      dataset: 'uniform_sizes',
      columns: ['product_name', 'size'],
      filters: [
        { column: 'product_kind', op: 'eq', value: 'uniform' },
        {
          column: 'order_status',
          op: 'in',
          value: ['paid', 'fulfilling', 'fulfilled'],
        },
      ],
      groupBy: ['product_name', 'size'],
      aggregates: [{ fn: 'sum', column: 'quantity' }],
    });

    expect(dataset.columns.map((column) => column.key)).not.toContain(
      'person_name',
    );
    expect(() => {
      validateReportDefinition(dataset, visible, definition);
    }).not.toThrow();
    expect(() => datasetForActor('uniform_sizes', ['registrar'])).toThrow(
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

  it('only buckets one date or datetime group into a time period', () => {
    const dataset = datasetForActor('registrations', ['registrar']);
    const visible = columnsForActor(dataset, ['registrar']);
    const valid = reportDefinitionSchema.parse({
      dataset: 'registrations',
      columns: ['id'],
      groupBy: ['created_at'],
      timeGrain: 'week',
      aggregates: [{ fn: 'count', column: 'id' }],
    });
    const invalid = reportDefinitionSchema.parse({
      dataset: 'registrations',
      columns: ['id'],
      groupBy: ['status'],
      timeGrain: 'week',
      aggregates: [{ fn: 'count', column: 'id' }],
    });

    expect(() => {
      validateReportDefinition(dataset, visible, valid);
    }).not.toThrow();
    expect(() => {
      validateReportDefinition(dataset, visible, invalid);
    }).toThrow('A time period requires one date or datetime group column');
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
