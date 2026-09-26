# 40 — Operator Checklist (human-only steps)

Codex: keep this file current. Add a step only when it truly requires a human with credentials, money, legal authority or external approval. For each step, state exactly where in the product/config the result is entered and how to verify it.

Owner: work through these after Codex finishes, in order.

## Accounts and infrastructure
1. **Domain** — register the production domain; set `APP_DOMAIN`, `APP_URL`. Configure wildcard DNS `*.APP_DOMAIN` for org subdomains.
2. **Hosting** — create the web ×2 and worker ×1 services from `render.yaml` (or equivalent), managed Postgres 16 with PITR ≥ 14 days, S3-compatible bucket (private) with versioning, and a second bucket/location for nightly encrypted dumps. Run `scripts/create-db-roles.sql` as the database owner. Set all environment variables from `docs/ENVIRONMENT.md`.
3. **Encryption keys** — generate with `npm run keys:generate` and store in the host's secret manager; store an offline copy securely. Losing them makes Restricted data unrecoverable.
4. **Platform admin** — run `scripts/create-platform-admin.ts` in production; enroll MFA immediately.
5. **Sentry** — create projects (server, web), set `SENTRY_DSN`, configure alert routing.
6. **Custom domains for orgs (optional at launch)** — set up Cloudflare for SaaS (or host equivalent) for TLS on customer hostnames; follow `docs/ops/CUSTOM-DOMAINS.md`.

## Payments
7. **Stripe platform account** — complete business verification; enable Connect; set platform profile, branding (icon, color), Express dashboard settings; enable payment methods (cards, ACH Direct Debit with Financial Connections, Apple Pay, Google Pay, Link).
8. **Webhooks** — create platform and Connect webhook endpoints pointing to `/api/v1/webhooks/stripe` and `/api/v1/webhooks/stripe-connect` with the event list in Phase 4; set secrets.
9. **Apple Pay** — register and verify the production domains (and each verified custom domain; the product triggers registration via API once the platform is verified).
10. **Stripe Billing** — create products/prices for Pro/Enterprise plans; paste price ids in the platform console plans screen.
11. **Pricing decision** — confirm application fee and plan prices in the platform console (seed defaults are placeholders from D7). Confirm the processing-cost estimate used by the service-fee gross-up.
12. **Live-mode smoke** — with a real card and a real test org you control, run one $1 registration and refund it; verify reconciliation report.

## Messaging
13. **Resend** — verify the sending domain (SPF, DKIM, DMARC `p=quarantine` after monitoring), set `RESEND_API_KEY`, `MAIL_FROM`, webhook secret; send test emails to Gmail/Outlook/Yahoo and check spam placement.
14. **Twilio** — buy a number or messaging service, complete **A2P 10DLC** brand and campaign registration (use the consent language from the product's SMS opt-in screen and screenshots), enable Advanced Opt-Out, set webhooks for status and inbound messages. Expect days to weeks for approval.
15. **Web Push** — generate VAPID keys with `npm run keys:vapid`, set env vars.

## Compliance vendors (optional at launch)
16. **Checkr** — apply for a Checkr partner/customer account suitable for youth-sports volunteers; set `CHECKR_API_KEY`; enable per org in platform console. Until then orgs use the manual background-check provider.

## Legal and trust
17. **Lawyer review** of Terms, Privacy Policy (children's data/COPPA), DPA, Acceptable Use, subprocessors list, cookie statement, SMS terms, FCRA background-check disclosure/authorization and adverse-action templates, donation receipt language, refund policy template, incident-response notification obligations. Then set `LEGAL_DOCS_APPROVED=true`.
18. **Insurance** — cyber liability / technology E&O coverage appropriate for handling minors' data and payments.
19. **Penetration test** by a third party on staging; fix findings; keep the report.
20. **Accessibility audit** by a third party (VPAT/ACR if selling to parks & rec / public entities).
21. **1099 threshold** — confirm with an accountant the current reporting threshold used in the officials pay report (default $2,000) and update the org default.

## Launch operations
22. Support inbox and hours; status page URL; on-call rotation for registration-open peaks (Sunday evenings and August/January are typical peaks).
23. Restore drill in production-like staging; record results.
24. Beta: onboard 2–3 friendly orgs (one per operating model) before public launch; watch payment and delivery dashboards daily for the first two weeks.
25. **Competitor import presets** — collect real export files (with the org's permission) from SportsEngine, LeagueApps, TeamSnap and PlayMetrics customers and add mapping presets (see `docs/help/import-presets.md`).
