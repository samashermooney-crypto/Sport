# Athlentry

A sports-management foundation built with React, TypeScript, Express and SQLite. LeagueApps informed early workflow research; matching its screens or feature catalog is no longer the objective. No third-party partnerships are claimed. Current completion gates and known gaps are tracked in [docs/FOUNDATION.md](docs/FOUNDATION.md).

## Run locally

Requires Node.js 22.13+ with `node:sqlite`.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API listens on port 3001; both bind to loopback. Fictional demo administrator: `admin@athlentry.local` / `AthlentryDemo!2026`.

Data persists in `data/fieldhouse.sqlite`. `DATABASE_PATH` selects another database. Demo seed data initializes only when no organization exists and seeding is allowed (`NODE_ENV=production` skips it unless `SEED_DEMO=true`); `DEMO_PASSWORD` changes the initial demo password for a new database. No live LeagueApps credentials or customer records are copied into the seed.

For a real (non-demo) organization, run `npm run init` — it creates the first owner account from validated flags and a hidden password prompt. See [docs/BACKEND-INITIALIZATION.md](docs/BACKEND-INITIALIZATION.md).

```sh
npm test
npm run build
npm start
```

`npm start` serves the built application from the API server. Deployment infrastructure, HTTPS and live provider configuration still require setup and verification.

## Implemented foundation

- Programs and configuration, registration eligibility/capacity/waitlists, questions and versioned waiver evidence.
- Members, families, profile questions and private attachments; separate member accounts, signup verification, password recovery, family registration and account records.
- Teams, roster management and staff assignments; schedules, CSV import, results and standings.
- Invoices, local offline payment records, installments, discounts and credits; cancellation, reenrollment and transactional registration transfers.
- Message audiences, drafts/templates, held queues and provider adapters.
- Public website pages and program discovery, restricted content, product catalog, member checkout, inventory reservations and order management.
- Organization-scoped permissions, session authentication, audit records and transactional data changes.
- Console user administration: owner-managed invitations, role and activation changes, password change/recovery; member account activation for existing adult records. API details: [docs/BACKEND-API-CONTRACT.md](docs/BACKEND-API-CONTRACT.md).

These are implemented areas, not a claim that every workflow has completed final browser and mobile acceptance. See the foundation checklist for outstanding verification. Specialized tryouts, bookings, advanced analytics, alternate website editors and integration management are deferred.

## Payments and delivery

Offline payments record receipts; they do not move money. Real card/bank processing and refunds are not operational. Registration transfers retain payments on the source invoice and explicitly review any destination charge.

Member signup and password recovery use labeled local email previews when auth delivery is disabled in development. Production disables previews. To configure account email, set `AUTH_EMAIL_DELIVERY_ENABLED=true`, `RESEND_API_KEY`, `MAIL_FROM` and an HTTPS `PUBLIC_URL` in the server environment. Live delivery has not been verified. Member and administrator sessions are separate. Recovery applies to existing member accounts; it does not claim unlinked administrator-created member records.

Messaging uses `MESSAGE_DELIVERY_ENABLED=true`, plus `RESEND_API_KEY` and `MAIL_FROM` for email, or `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` for SMS. Keep credentials in the server's secret configuration. Without configuration, messages remain held. Configuring credentials does not release existing messages; administrators review and release them individually.

```sh
npm run messages:deliver
```

This processes up to 100 queued recipients and is not automatically scheduled. Provider acceptance is distinct from delivery. Unknown outcomes and interrupted processing require reconciliation before retrying; delivery/open/click webhooks and a reconciliation interface remain outstanding. The fictional verification message addressed to `example.com` must remain held or be canceled.

## Data recovery and verification

Use the validated snapshot command and restore procedure in [docs/BACKUP.md](docs/BACKUP.md). Uploaded images and private form files are included in SQLite. Protect backups as private account data.

Automated tests cover domain invariants and HTTP access boundaries, including registration lifecycle, billing records, recovery and commerce. Browser checks supplement those tests; passing tests alone does not certify the whole interface. Historical implementation notes are in [docs/RESUME.md](docs/RESUME.md). Older replication notes are historical reference, not the current finish line.
