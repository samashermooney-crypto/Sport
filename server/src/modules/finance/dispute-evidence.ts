import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

export type EvidenceClaim =
  | { kind: 'reserved'; key: string; evidence: Record<string, string> }
  | { kind: 'replay'; status: string }
  | { kind: 'busy' };

export interface DisputeEvidenceRepository {
  claim(orgId: string, disputeId: string): Promise<EvidenceClaim>;
  beginExternal(orgId: string, disputeId: string, key: string): Promise<void>;
  complete(
    orgId: string,
    disputeId: string,
    key: string,
    status: string,
  ): Promise<void>;
}

/** Submits a database-built packet once; uncertain Stripe outcomes require reconciliation. */
export class DisputeEvidenceService {
  constructor(
    private readonly gateway: Pick<PaymentsGateway, 'submitDisputeEvidence'>,
    private readonly repository: DisputeEvidenceRepository,
  ) {}

  async submit(orgId: string, disputeId: string): Promise<string> {
    const claim = await this.repository.claim(orgId, disputeId);
    if (claim.kind === 'replay') return claim.status;
    if (claim.kind === 'busy')
      throw new Error('Dispute evidence submission requires reconciliation');
    await this.repository.beginExternal(orgId, disputeId, claim.key);
    const result = await this.gateway.submitDisputeEvidence({
      disputeId,
      evidence: claim.evidence,
      idempotencyKey: `dispute:evidence:${disputeId}:${claim.key}`,
    });
    if (result.id !== disputeId)
      throw new Error(
        'Stripe returned a different dispute after evidence submission',
      );
    await this.repository.complete(orgId, disputeId, claim.key, result.status);
    return result.status;
  }
}
