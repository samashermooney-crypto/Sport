# Operations runbook

This runbook covers the reference deployment. Keep an incident log with timestamps, affected service, operator actions and evidence. Do not copy child/family records, credentials or payment details into the log. Use read-only checks first; financial, safety, compliance and audit records are retained and never hard-deleted.

## Service health and alert rules

- `/healthz` is a liveness check. `/readyz` is the load balancer readiness check and must return 200 only when the web process can reach PostgreSQL. `/status` is public and reports only operational/degraded service state; it never returns tenant names, counts, provider IDs, error messages or credentials.
- Alert when no active worker heartbeat has arrived for 90 seconds, a queue has more than 1,000 pending jobs for five minutes, or any payment/webhook queue has a failed job. Alert on webhook silence only when a successful charge occurred during the same 24-hour window. Alert when payment failures exceed 5% across at least 20 attempts in 15 minutes, or email bounces exceed 5% across at least 100 sends in 30 minutes.
- Route alerts to the on-call operator and Sentry. Keep alert payloads to metric name, environment, time window and counts/rates; never include person, household, message, account or card data. A notification is not proof that the corresponding repair succeeded.
- Queue depth, failed-job summaries, worker heartbeat and recent Stripe event state are available in the platform health view to authorized platform staff. Public status omits these details.

## Failed deploy and rollback

1. Check Render deploy output, `/readyz`, database connectivity and the last successful release. Pause further deploys and note the current build/release IDs.
2. If readiness failed before migrations completed, fix configuration or application code and redeploy. If the new release is unhealthy after migration, roll back the application image to the last healthy build only when its code is compatible with the expanded schema.
3. Do not roll back by dropping columns or restoring the database to an earlier schema while new code is running. Migrations follow expand/contract: deploy additive schema first, deploy code that can read/write both shapes, backfill, then remove old schema in a later release after all old instances and workers are stopped.
4. If data integrity is at risk, stop writes through the approved maintenance control, page the database operator, and follow the restore procedure below. Preserve logs and audit history.

### Expand/contract migration release sequence

1. **Expand:** make the next migration additive. Add nullable columns, new tables or compatible indexes without removing or renaming fields used by the current release. Keep defaults cheap and avoid table rewrites. Migrations are run transactionally by `npm run db:migrate` from the Render pre-deploy job.
2. **Deploy compatible code:** all web instances and workers must tolerate both the old and expanded schema. When a transition requires dual writes, make them idempotent and observable; reads must tolerate old rows until the backfill completes.
3. **Backfill and verify:** run bounded, resumable batches outside the deploy transaction. Verify row totals and constraints with the feature owner before switching reads. Do not run an unbounded rewrite from a web request or pre-deploy hook.
4. **Contract later:** in a separate release after every web and worker instance runs compatible code, remove old reads/writes and then remove the old column/table in a later migration. Preserve audit and retained legal/financial records.
5. **Large indexes:** the standard migration runner wraps each migration in a transaction, so `CREATE INDEX CONCURRENTLY` cannot be placed in those files. For large live tables, coordinate a separately reviewed online index operation and record completion before code depends on it.

### Database roles

Run `scripts/create-db-roles.sql` as a PostgreSQL superuser for each application database after setting `ATHLENTRY_APP_ROLE_PASSWORD`, `ATHLENTRY_ADMIN_ROLE_PASSWORD` and `ATHLENTRY_BACKUP_ROLE_PASSWORD` in the operator environment. The script is rerunnable; run it again after migrations if `pgboss` was not present during initial role setup so the backup grants cover the durable job tables too. The app role is tenant-scoped and cannot bypass RLS; the admin role is limited to migrations and scratch-database restore work; the backup role is read-only with `BYPASSRLS` and belongs only in a restricted backup runner. Do not pass role passwords as command-line arguments or copy them into web/worker secrets.

## Stuck jobs and queue backlog

1. Check the worker heartbeat age, queue pending/failed counts and deploy history. Confirm the worker has `DATABASE_URL` and required provider configuration without printing environment values.
2. Inspect a failed job's redacted summary and its module's idempotency behavior. Fix the cause before retrying; provider timeouts may mean an email or payment operation already completed externally.
3. Use the authorized platform operation for the specific queue. Do not delete queue rows or blindly retry payment, refund, compliance or outbound-message work with direct SQL.
4. For a Stripe event that remains unprocessed, use the replay procedure. Confirm processed counts and resulting domain state before another replay.

## Stripe webhook backlog replay

Run `node --import tsx scripts/replay-stripe-events.ts` with the intended environment's `DATABASE_URL` and `STRIPE_SECRET_KEY`. The command replays only stored, unprocessed, unleased event IDs through the existing Stripe dispatcher; one run is limited to 100 events. Handlers retain their normal event claim and idempotency rules. It does not retrieve new events from Stripe or create a charge. Review the output count and the platform payment/webhook view. Do not run repeatedly against a poison event without resolving its error first.

## Email or SMS provider outage

1. Confirm provider status using the provider's official status page and inspect redacted delivery failure/bounce rates.
2. Keep the affected adapter in a suppressed/preview state if credentials, sender verification, opt-out compliance or signing validation are uncertain. Do not switch tests or local development to live delivery.
3. Let durable retry/backoff operate. After recovery, verify signed delivery callbacks and bounce/complaint suppression. Do not manually resend a campaign without checking for deliveries that succeeded before the outage.

## Database restore

1. Declare the recovery point and recovery owner. Use managed PostgreSQL point-in-time recovery (minimum 14 days configured) for primary recovery. Preserve the failed instance until the recovery has been validated.
2. For a logical backup, select the newest encrypted dump from the separate versioned bucket, verify its timestamp and object checksum, and provide `BACKUP_ENCRYPTION_KEY` through the restricted restore runner's secret manager. The nightly backup cron runs at 02:00 UTC and treats upload failure as job failure. Never decrypt a production dump to a developer laptop.
3. Restore only to a new, isolated scratch/standby database first. Provide `RESTORE_SOURCE_URL` using the read-only backup role and `RESTORE_ADMIN_URL` pointing to the same cluster's `postgres` maintenance database with a `CREATEDB` role, then run `node --import tsx scripts/restore-drill.ts`. The script compares migration state and row counts in organizations, people, registrations, attendance, invoices, payments and audit log against the source snapshot. Do not point application traffic to it until the database operator approves.
4. For a real recovery, restore PITR or the verified logical backup into a separate managed database, validate access controls, RLS, migrations, recent finance reconciliation and object-store references, then coordinate the connection switch. Retain the original and recovery audit trail.

Nightly logical dumps are AES-256-GCM encrypted by `node --import tsx scripts/backup.ts`. The Render blueprint runs this in a restricted cron at 02:00 UTC. It receives `BACKUP_DATABASE_URL` (the read-only `athlentry_backup` role with `BYPASSRLS`), the dedicated encryption key and write credentials for the backup bucket; it does not receive application, payment or message-provider credentials. Configure all `BACKUP_S3_*` values so the script uploads only ciphertext over signed HTTPS to the separate versioned bucket; a production backup run fails if object storage is not configured. Keep the encryption key separately from the backup object. Enable bucket versioning and test object retrieval. Managed PostgreSQL PITR and object-storage versioning remain required even when logical dumps succeed.

## Key rotation

1. Generate replacement data-encryption keys with `npm run keys:generate` and VAPID keys with `npm run keys:vapid`; store generated output directly in the approved secret manager. Do not paste keys into an issue, terminal recording or Git file.
2. Add a new data key while retaining old key IDs, set `DATA_ENCRYPTION_ACTIVE_KID` to the new ID, deploy to all web and worker instances, then run the encryption rotation tool against a recent backup and verify decryption before/after.
3. Keep old keys until all encrypted rows and backups that need them have passed their retention window. For VAPID, update the public key advertised to browsers and schedule subscription renewal before removing the previous private key.
4. For database role credentials, create/rotate through the approved role-management process, deploy the new secret to all consumers, verify connections, then revoke the previous login. Never reuse the backup encryption key for row-level data encryption.

## Suspend an abusive organization

Use the audited platform organization-status control, provide the incident reason, and verify the suspended state. Do not delete registrations, money, safety, compliance or audit records. Follow the incident-response and legal escalation process for evidence preservation and any required notice.

## Data-subject request

Verify the requester and their authority before action. Use the privacy-request workflow and its step-up authorization; export only data the requester is entitled to receive. Deletion means anonymization according to the retention schedule, revocation of active access and an audit entry. Financial, waiver, compliance, safety and audit evidence remains retained as required. Record the request ID and completion status, not the subject's personal data.

## Dispute spike

Pause risky rollout or acquisition campaigns, inspect dispute rate and reason codes by authorized finance staff, and preserve payment evidence. Confirm Connect account and invoice allocations before responding. Use the platform dispute workflow and Stripe's configured response deadline; never submit fabricated evidence or alter source records. Escalate a sudden spike to finance, support and legal owners, then review registration, communication and refund policy changes.
