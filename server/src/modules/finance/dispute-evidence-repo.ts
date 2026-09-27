import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import type {
  DisputeEvidenceRepository,
  EvidenceClaim,
} from './dispute-evidence.js';

interface DisputeRow {
  id: string;
  payment_id: string;
  invoice_id: string | null;
  stripe_charge_id: string | null;
  amount_cents: number;
  status: string;
  evidence_due_by: Date | null;
  evidence_submitted_at: Date | null;
  evidence_submission_state: string;
  evidence_submission_key: string | null;
  evidence_packet_hash: string | null;
  evidence_packet: Record<string, string> | null;
  evidence_response_status: string | null;
}

interface RegistrationEvidenceRow {
  registration_id: string;
  person_id: string;
  program_name: string;
  registered_at: Date;
  status: string;
  waiver_signed_at: Date | null;
  waiver_version: number | null;
  waiver_method: string | null;
  attended_count: number;
}

function packetHash(packet: Record<string, string>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(packet).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex');
}

/** Builds factual evidence from tenant records and fences Stripe submission. */
export class PostgresDisputeEvidenceRepository implements DisputeEvidenceRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId)
      throw new Error('Dispute evidence organization mismatch');
  }

  async claim(orgId: string, disputeId: string): Promise<EvidenceClaim> {
    this.assertOrg(orgId);
    return this.withOrg(this.context, async (trx) => {
      const result = await sql<DisputeRow>`
        SELECT id, payment_id, invoice_id, stripe_charge_id, amount_cents,
          status, evidence_due_by, evidence_submitted_at,
          evidence_submission_state, evidence_submission_key, evidence_packet_hash,
          evidence_packet, evidence_response_status
        FROM disputes WHERE org_id = ${orgId}::uuid
          AND stripe_dispute_id = ${disputeId} FOR UPDATE
      `.execute(trx);
      const dispute = result.rows[0];
      if (!dispute) throw new Error('Dispute evidence source not found');
      if (dispute.evidence_submission_state === 'completed') {
        if (!dispute.evidence_response_status)
          throw new Error('Completed dispute evidence has no result');
        return { kind: 'replay', status: dispute.evidence_response_status };
      }
      if (dispute.evidence_submission_state === 'reserved') {
        if (
          !dispute.evidence_submission_key ||
          !dispute.evidence_packet ||
          !dispute.evidence_packet_hash
        )
          throw new Error('Reserved dispute evidence packet is incomplete');
        const actualHash = packetHash(dispute.evidence_packet);
        if (actualHash !== dispute.evidence_packet_hash)
          throw new Error('Reserved dispute evidence packet changed');
        return {
          kind: 'reserved',
          key: dispute.evidence_submission_key,
          evidence: dispute.evidence_packet,
        };
      }
      if (dispute.evidence_submission_state !== 'none') return { kind: 'busy' };
      if (
        dispute.status !== 'needs_response' ||
        dispute.evidence_submitted_at ||
        !dispute.evidence_due_by ||
        dispute.evidence_due_by <= new Date() ||
        !dispute.invoice_id
      )
        throw new Error('Dispute is not eligible for evidence submission');
      const allocation = await sql<{
        status: string;
        stripe_charge_id: string | null;
        amount_cents: number;
      }>`
        SELECT p.status, p.stripe_charge_id, pa.amount_cents
        FROM payments p
        JOIN payment_allocations pa ON pa.org_id = p.org_id AND pa.payment_id = p.id
        WHERE p.org_id = ${orgId}::uuid AND p.id = ${dispute.payment_id}::uuid
          AND pa.invoice_id = ${dispute.invoice_id}::uuid
      `.execute(trx);
      if (
        allocation.rows.length !== 1 ||
        allocation.rows[0]?.status !== 'succeeded' ||
        allocation.rows[0].stripe_charge_id !== dispute.stripe_charge_id ||
        allocation.rows[0].amount_cents < dispute.amount_cents
      )
        throw new Error(
          'Dispute evidence payment allocation does not reconcile',
        );
      const invoice = await trx
        .selectFrom('invoices')
        .select('refund_terms')
        .where('org_id', '=', orgId)
        .where('id', '=', dispute.invoice_id)
        .executeTakeFirstOrThrow();
      if (!invoice.refund_terms)
        throw new Error('Dispute invoice has no frozen refund terms');
      const registrations = await sql<RegistrationEvidenceRow>`
        SELECT r.id AS registration_id, r.person_id, p.name AS program_name,
          r.created_at AS registered_at, r.status,
          w.signed_at AS waiver_signed_at,
          w.document_version AS waiver_version,
          w.method AS waiver_method,
          COALESCE(a.attended_count, 0)::integer AS attended_count
        FROM registrations r
        JOIN invoice_lines il ON il.org_id = r.org_id
          AND il.id = r.invoice_line_id AND il.invoice_id = ${dispute.invoice_id}::uuid
        JOIN programs p ON p.org_id = r.org_id AND p.id = r.program_id
        LEFT JOIN LATERAL (
          SELECT signed_at, document_version, method
          FROM waiver_signatures ws WHERE ws.org_id = r.org_id
            AND ws.registration_id = r.id
          ORDER BY signed_at DESC, id DESC LIMIT 1
        ) w ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS attended_count FROM attendance at
          WHERE at.org_id = r.org_id AND at.person_id = r.person_id
            AND at.status IN ('present', 'late')
            AND at.created_at >= r.created_at
        ) a ON true
        WHERE r.org_id = ${orgId}::uuid
        ORDER BY r.created_at, r.id
      `.execute(trx);
      if (
        !registrations.rows.length ||
        registrations.rows.some(
          (registration) => !registration.waiver_signed_at,
        )
      )
        throw new Error(
          'Dispute packet needs registration and signed waiver evidence',
        );
      const facts = registrations.rows.map((registration) =>
        [
          `Registration ${registration.registration_id}`,
          `program ${registration.program_name}`,
          `created ${registration.registered_at.toISOString()}`,
          `status ${registration.status}`,
          `waiver signed ${String(registration.waiver_signed_at?.toISOString())}`,
          `waiver version ${String(registration.waiver_version)}`,
          `signature method ${String(registration.waiver_method)}`,
          `recorded attendances ${String(registration.attended_count)}`,
        ].join('; '),
      );
      const narrative = [
        ...facts,
        `Refund terms frozen at invoice issuance: ${JSON.stringify(invoice.refund_terms)}`,
      ].join('\n');
      if (narrative.length > 20_000)
        throw new Error('Dispute evidence exceeds Stripe text limit');
      const evidence = {
        product_description: registrations.rows
          .map((registration) => registration.program_name)
          .join(', ')
          .slice(0, 500),
        uncategorized_text: narrative,
      };
      const key = newId();
      const hash = packetHash(evidence);
      await sql`
        UPDATE disputes SET evidence_submission_state = 'reserved',
          evidence_submission_key = ${key}::uuid,
          evidence_packet_hash = ${hash},
          evidence_packet = ${JSON.stringify(evidence)}::jsonb,
          version = version + 1
        WHERE org_id = ${orgId}::uuid AND id = ${dispute.id}::uuid
      `.execute(trx);
      return { kind: 'reserved', key, evidence };
    });
  }

  async beginExternal(
    orgId: string,
    disputeId: string,
    key: string,
  ): Promise<void> {
    this.assertOrg(orgId);
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE disputes SET evidence_submission_state = 'external_started',
          version = version + 1
        WHERE org_id = ${orgId}::uuid AND stripe_dispute_id = ${disputeId}
          AND evidence_submission_key = ${key}::uuid
          AND evidence_submission_state = 'reserved'
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new Error('Dispute evidence was not reserved');
    });
  }

  async complete(
    orgId: string,
    disputeId: string,
    key: string,
    status: string,
  ): Promise<void> {
    this.assertOrg(orgId);
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE disputes SET evidence_submission_state = 'completed',
          evidence_submitted_at = now(), evidence_response_status = ${status},
          version = version + 1
        WHERE org_id = ${orgId}::uuid AND stripe_dispute_id = ${disputeId}
          AND evidence_submission_key = ${key}::uuid
          AND evidence_submission_state = 'external_started'
        RETURNING id
      `.execute(trx);
      const dispute = updated.rows[0];
      if (!dispute)
        throw new Error('Dispute evidence submission was not started');
      await appendAuditEvent(trx, this.context, {
        action: 'dispute.evidence_submitted',
        entityType: 'dispute',
        entityId: dispute.id,
        changes: {
          status: {
            tier: 'internal',
            before: 'external_started',
            after: status,
          },
        },
      });
    });
  }
}
