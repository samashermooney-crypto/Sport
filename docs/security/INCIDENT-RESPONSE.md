# Security incident response

**Status:** operational draft. Replace the role/contact placeholders and have
counsel review notification obligations before production launch.

## Detection and escalation

Treat suspected account takeover, cross-tenant access, unauthorized access to a
minor or Restricted record, leaked secrets, payment/webhook tampering, malicious
uploads, or a compromised dependency or deployment as a security incident.
Record the first observed time, reporter, affected systems, evidence locations,
and a short description in the restricted incident log. Do not copy passwords,
session tokens, payment data, medical narratives, or other unnecessary personal
data into chat, tickets, or logs.

The incident lead is the on-call platform security owner (contact: **to be
assigned**). Escalate to the engineering incident lead, privacy lead, finance
lead for payment events, and legal counsel for possible notification decisions.
If no contact is staffed, page the designated platform operator and preserve
evidence while access is limited.

## First response

1. Confirm the report with the smallest safe reproduction. Use synthetic data
   and Stripe test mode; never reproduce by accessing a real family's records.
2. Preserve request IDs, relevant redacted application logs, audit records,
   provider event IDs, deployment identifiers, and timestamps in a restricted
   evidence location. Record who collected each item and when. Do not alter or
   delete audit, financial, compliance, waiver, or safety records.
3. Identify affected accounts, organizations, data classes, integrations and
   time window. Check whether access succeeded or was only attempted.
4. Assign one incident lead and one note taker. Keep communications factual,
   timestamped, and limited to responders who need access.

## Containment

- Account/session compromise: suspend the account as needed, revoke active
  sessions and devices, rotate recovery/MFA credentials, and preserve security
  events. Do not delete identity or audit history.
- Tenant authorization issue: disable the affected route or capability behind
  an approved control, block the vulnerable access path, and inspect access
  logs across tenants. Keep the service available when a narrow control can
  contain the issue safely.
- Secret or encryption-key exposure: revoke/rotate the affected provider or
  encryption key, preserve the key IDs and rotation evidence (never the secret
  value), and follow `docs/ops/RUNBOOK.md` once available. Re-encrypt stored
  values with `scripts/rotate-encryption-key.ts` after validating the new key.
- Payment/webhook incident: pause the affected operation in test/staging first;
  preserve Stripe event IDs and reconciliation evidence. Do not issue a live
  charge, refund, transfer, or payout while investigating.
- Malicious file or content: disable access to the affected object or content,
  retain its audit evidence, and verify all derived image variants and public
  copies are contained.

## Eradication and recovery

Fix the root cause, add a regression test, review the affected code and tenant
boundaries, and have a second engineer review security-sensitive changes. Deploy
through the normal release procedure. Verify the affected route, session,
provider callback, and tenant boundary with synthetic fixtures. Restore normal
traffic only after the incident lead records the evidence and residual risk.
Continue heightened monitoring for at least one normal operational cycle.

## Notification and closure

The privacy lead and counsel determine whether affected families, organizations,
providers, insurers, regulators, or law enforcement must be notified, and the
timing/content of those notices. This document does not state a legal deadline.
Counsel must maintain jurisdiction-specific notification requirements and
approved notice templates. Never delay containment while waiting for a notice
decision.

Close an incident only after the incident lead records: timeline, affected
scope, root cause, containment and recovery, notifications decided/sent, tests
added, remaining risks, and follow-up owners/dates. Retain this record under the
applicable incident and audit retention policy. Run a tabletop exercise before
production launch and annually thereafter.

## Response contacts (complete before production)

- Security incident lead: **to be assigned**
- Engineering on-call: **to be assigned**
- Privacy lead: **to be assigned**
- Legal counsel: **to be assigned**
- Payment provider escalation: Stripe dashboard/operator contact
- Hosting/storage escalation: hosting and object-storage operator contacts
