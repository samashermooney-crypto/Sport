import { describe, expect, it } from 'vitest';

import {
  canAdjudicateIneligible,
  earliestAdverseActionDate,
} from './fcra-timeline.js';

describe('FCRA timeline', () => {
  it('waits five business days after pre-adverse notice', () => {
    expect(earliestAdverseActionDate('2026-09-04')).toBe('2026-09-11');
    expect(canAdjudicateIneligible('2026-09-04', '2026-09-10')).toBe(false);
    expect(canAdjudicateIneligible('2026-09-04', '2026-09-11')).toBe(true);
  });

  it('skips provided holidays and refuses action without notice', () => {
    expect(earliestAdverseActionDate('2026-09-04', ['2026-09-07'])).toBe(
      '2026-09-14',
    );
    expect(canAdjudicateIneligible(null, '2026-09-20')).toBe(false);
  });
});
