import { describe, expect, it, vi } from 'vitest';

import {
  DisputeEvidenceService,
  type DisputeEvidenceRepository,
} from './dispute-evidence.js';

describe('dispute evidence submission', () => {
  it('submits one database-built packet with a stable key and replays completion', async () => {
    const gateway = {
      submitDisputeEvidence: vi.fn().mockResolvedValue({
        id: 'dp_test',
        status: 'under_review',
      }),
    };
    let state = 'none';
    const repository: DisputeEvidenceRepository = {
      claim: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            state === 'completed'
              ? { kind: 'replay', status: 'under_review' }
              : {
                  kind: 'reserved',
                  key: 'fixed-key',
                  evidence: { uncategorized_text: 'recorded facts' },
                },
          ),
        ),
      beginExternal: vi.fn().mockImplementation(() => {
        state = 'external_started';
        return Promise.resolve();
      }),
      complete: vi.fn().mockImplementation(() => {
        state = 'completed';
        return Promise.resolve();
      }),
    };
    const service = new DisputeEvidenceService(gateway, repository);
    expect(await service.submit('org', 'dp_test')).toBe('under_review');
    expect(await service.submit('org', 'dp_test')).toBe('under_review');
    expect(gateway.submitDisputeEvidence).toHaveBeenCalledExactlyOnceWith({
      disputeId: 'dp_test',
      evidence: { uncategorized_text: 'recorded facts' },
      idempotencyKey: 'dispute:evidence:dp_test:fixed-key',
    });
  });

  it('holds an uncertain external submission for reconciliation', async () => {
    const gateway = {
      submitDisputeEvidence: vi
        .fn()
        .mockRejectedValue(new Error('network timeout')),
    };
    let started = false;
    const complete = vi.fn();
    const repository: DisputeEvidenceRepository = {
      claim: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            started
              ? { kind: 'busy' }
              : {
                  kind: 'reserved',
                  key: 'fixed-key',
                  evidence: { uncategorized_text: 'facts' },
                },
          ),
        ),
      beginExternal: vi.fn().mockImplementation(() => {
        started = true;
        return Promise.resolve();
      }),
      complete,
    };
    const service = new DisputeEvidenceService(gateway, repository);
    await expect(service.submit('org', 'dp_test')).rejects.toThrow(
      'network timeout',
    );
    await expect(service.submit('org', 'dp_test')).rejects.toThrow(
      'requires reconciliation',
    );
    expect(gateway.submitDisputeEvidence).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
