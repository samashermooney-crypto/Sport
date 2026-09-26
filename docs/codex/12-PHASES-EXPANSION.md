# 12 — Phases 10–15: Expansion

---

## Phase 10 — Communications: campaigns, notifications, email/SMS/push/in-app, chat

### Tasks
1. Channel adapters: Resend (email) with webhook for delivered/bounced/complained/opened/clicked (signature verified; open/click tracking only for campaigns, never for security emails), Twilio Messaging Service (SMS) with status callbacks and inbound STOP/START/HELP handling updating `suppressions`, Web Push (VAPID) with subscription management and invalid-subscription cleanup, in-app (notifications + SSE).
2. Sender identity: org display name, reply-to address (org setting, verified by email), platform sending domain (`notifications@APP_DOMAIN`) with per-org From name; custom sending domain is an operator feature (document; out of scope for self-serve).
3. SMS consent: capture at account/phone entry per `04 §8`; only consenting numbers receive SMS; per-org sender compliance text; quiet hours (no non-emergency SMS/push 9pm–8am recipient local time; queued until morning).
4. Campaign composer: audience builder (`02 §N AudienceSpec`) with live recipient count and preview list, channels selection, rich email editor (TipTap) with merge fields (`{{guardian.first_name}}`, `{{athlete.first_name}}`, `{{team.name}}`, `{{event.next.start}}`…) and fallback values, SMS text with segment counter, push text, per-locale variants with **"Translate to Spanish"** (Phase 15 AI adapter if configured; otherwise manual), test send to self, schedule, send with confirmation of counts per channel, cancel scheduled.
5. Delivery pipeline: resolve recipients (dedupe per account; guardians for minors; suppressed addresses skipped and counted), fan out `message_deliveries`, per-channel sending with retries (exponential backoff, max 5, idempotent provider keys), status updates from webhooks, campaign stats (sent/delivered/bounced/opened/clicked/failed per channel), bounce handling → suppression + Action Center.
6. Notification catalog (code-defined, each with category, default channels, templates en/es, and preference key). Minimum catalog: account security events; registration confirmed/waitlisted/offered/approved/declined/canceled/transferred; checkout abandoned; invoice issued; payment succeeded/failed; installment upcoming/failed/final notice; refund issued; autopay card expiring; credential expiring/expired/approved/rejected; background check invitation/result pending; staff activated/pending compliance; team placement published; offer sent/expiring; schedule published/changed (batched); event canceled/postponed/closure; RSVP reminder (24 h before, only if no RSVP); result posted (opt-in); official assignment offered/changed; volunteer shift reminder (24 h); volunteer requirement behind; injury reported (guardian); new chat message (batched per conversation, 10-minute window); incident assigned; data export ready; privacy request update; org invitation.
7. Preferences center (portal and email footer link, tokenized without sign-in for unsubscribe): per org, per category, per channel; operational/emergency cannot be fully disabled; marketing requires opt-in.
8. Chat: team conversations auto-created per team_season (members = active staff + guardians + athletes 13+ if enabled), staff-only team channel, announcement-only channels, org-created groups; SafeSport policy (`04 §4`) enforced on membership changes and direct messages; messages with attachments (images/pdf via files module), edit (15 min) and soft delete, read receipts (counts, not per-person for families), mute, report message → compliance incident; moderation view for admins/compliance; realtime via SSE; push/email fallback for unread per preferences.
9. Message history on person/household profiles (what each account was sent, delivery status).
10. Emergency broadcast: one-click "Emergency message" (weather, safety) to an org/facility/program audience across all channels, bypassing quiet hours, restricted to admins/owners, requires confirmation.

### Acceptance criteria
- Campaign to "U10 guardians with past-due balance" resolves the correct accounts (test), skips suppressed addresses, respects locale, and records per-channel stats from simulated webhooks.
- STOP via Twilio inbound fixture suppresses SMS for that number across the org within one request; START re-enables.
- SafeSport: attempt to create a direct conversation coach↔minor without guardian → `SAFESPORT_GUARDIAN_REQUIRED`; team chat always includes guardians of minor members (tests); coach message to athlete 16 auto-copies guardians (e2e).
- Quiet hours: a non-emergency SMS scheduled at 22:00 recipient time is sent at 08:00; emergency sends immediately.
- Batched schedule-change notification: 5 changes within 15 minutes produce one message per family listing all changes.
- Playwright: admin composes bilingual campaign, sends; guardian with `es` locale receives Spanish email in Mailpit; unsubscribe link disables that category only.

---

## Phase 11 — Volunteers, team finances, fundraising, sponsors, store and uniforms

### Tasks
1. Volunteers: roles (with credential requirements and min age), requirements per season/program (hours or shifts per household or per athlete, deadline, buyout price), shifts (single or generated from events, e.g. "concession stand for every Saturday game block"), signup in portal (by household member, capacity-limited, compliance-gated), reminders, check-in by coordinator or QR at the shift, hours credited, no-show handling, household progress ledger, buyout purchase anytime before deadline (creates invoice line), end-of-season enforcement options (auto-invoice buyout for shortfall with notice N days before — org setting, default off), coach/team-parent roles counted toward requirement only if configured.
2. Team finances: team ledger per team_season (budget, income/expense entries with categories and receipt uploads), team fee assessments to families (per player, due dates, installment templates) collected through the org's Stripe account with GL code tagging so payments land in the team ledger, reimbursement requests with approval by club finance, treasurer view for team role, club-wide oversight dashboard (balances per team, overdue team fees), export per team.
3. Fundraising: campaigns (org-wide or per team) with public page, goal thermometer, donor wall (opt-in), donation checkout (guest allowed, Turnstile), recurring donations are out of scope (document), donation receipts with IRS-compliant acknowledgment text when the org is nonprofit (org name, EIN last 4 digits masked except when the org opts to show full EIN, amount, date, statement that no goods or services were provided or the value of quid-pro-quo goods), year-end donor statement.
4. Sponsors: records, tiers, contract dates, logo, placements on website/program/team pages and email footers, invoicing via finance module, renewal reminders.
5. Store & uniforms: port products/variants/categories/orders from legacy with the inventory ledger, orders paid through finance, fulfillment (pickup or ship, status, notifications), registration add-ons (required uniform kit with sizes, optional spirit wear), uniform size report per team/program, low-stock alerts, sales tax per `tax_rates`.

### Acceptance criteria
- Volunteer e2e: household required 2 shifts; signs up for one, checked in and credited; buys out the second; ledger shows complete.
- Team fee e2e: club assesses $450 per player in 3 installments to one team; family pays first installment; team ledger shows income tagged to the team; treasurer submits a reimbursement; club finance approves.
- Donation e2e (guest): donor gives $300 to a team campaign; receipt email contains required acknowledgment text; campaign total updates on public page.
- Uniform size report totals match add-on selections for the seeded club (test).
- Inventory ledger never negative under concurrent orders (concurrency test).

---

## Phase 12 — Academy / class mode

### Tasks
1. Class offerings with levels, age ranges in months (e.g. 36–60 months), capacity and instructor ratio, billing mode (term, monthly, drop-in, punch card), tuition tiers by classes per week per family, trial class option, make-up policy (credits per term, expiry, eligible classes).
2. Class schedules generating `class_session` events for a term with holidays/blackouts skipped; instructor assignment with compliance gating; substitute instructor.
3. Enrollment flow in portal: browse by age/level/day/time, see available spots, enroll (or trial), waitlist per class, family discount rules, registration fee (annual) handling.
4. Tuition subscriptions (`02 §P`): monthly invoices on billing day via `classes.tuition` job, autopay charging through Phase 4 engine, proration for mid-month starts and withdrawals (`20 §11`), pauses (vacation hold) with policy, withdrawal notice period (e.g. 30 days) enforcement, failed payment dunning, drop-in and punch-card purchases.
5. Attendance per session with check-in/out and pickup verification; absences generate make-up credits per policy; make-up booking into eligible sessions with capacity.
6. Skill levels and skills (from sport profile, editable), skill tracking per athlete by instructors (tablet UI per class session), progress reports visible to guardians, level promotion workflow (evaluation → recommendation → promotion → moves enrollment to next level class with family confirmation), certificates (PDF).
7. Staff ratio monitoring: warn when enrollment/attendance exceeds instructor ratio.
8. Academy dashboard: enrollment by level/class, capacity utilization heat map (day × time), churn (withdrawals per month), tuition MRR, failed payments.

### Acceptance criteria
- Seeded gymnastics academy: 40 classes, 300 students; monthly tuition job generates correct invoices with tier pricing and sibling discount; proration test cases pass (`20 §11`).
- Make-up flow e2e: absence → credit → book make-up in another class with space → attendance recorded.
- Level promotion updates enrollment, billing tier, and notifies guardian.

---

## Phase 13 — Federation: associations, leagues with member clubs

### Tasks
1. Relationships: parent org invites child org (by slug/owner email) or child requests to join; acceptance by child owner; data-sharing agreement screen listing exactly which datasets are shared (`org_relationships.data_sharing`); end relationship.
2. Inter-club league programs owned by the league org: member clubs submit team entries (their own team_seasons) with roster snapshots; league sets roster submission deadlines and roster freeze; league approves entries.
3. Cross-org eligibility and compliance visibility: league sees member-team rosters (names, DOB-derived age group, card numbers, photo if consent) and staff compliance **status only** (not documents/medical) through the privileged `federation` service using explicit allow-listed fields; every cross-org read audited in both orgs.
4. League-wide scheduling across member club facilities: member clubs contribute field availability windows to the league; generator uses combined availability; clubs see their home games.
5. League results, standings, discipline across clubs (discipline records visible to the involved club); referee pool at league level with assignments across member clubs' home games.
6. Association dashboards: member clubs list with key counts (teams, players, compliance %), outstanding entry fees, discipline summary.
7. League/association fees charged to member clubs (club pays via invoice; club org is the payer through an org-level payer profile).

### Acceptance criteria
- RLS still prevents any direct cross-org access; federation service tests prove only allow-listed fields are returned and every access is audited in both orgs.
- Seeded association with 2 member clubs runs an inter-club U12 league: entries submitted, approved, schedule generated using both clubs' fields, results entered by home club, standings visible to both.
- Ending a relationship stops data access immediately (test).

---

## Phase 14 — Reporting, dashboards, action center completion, website, exports

### Tasks
1. Report builder over curated datasets (people, households, registrations, rosters, invoices, invoice lines, payments, refunds, installments, attendance, credentials, background checks (status only), volunteers, evaluations, offers, events/results, officials pay, donations, orders): column picker with tier-aware visibility, filters (typed per column), grouping and aggregates (count, sum, avg, min, max), sort, preview (first 200 rows), export CSV/XLSX (formula-injection safe), save, share with roles, schedule email delivery (CSV attachment only for Internal-tier datasets; otherwise a secure link requiring sign-in).
2. Standard reports listed in `05 §3` implemented as saved-report presets plus dedicated visual pages where charts help (registration pace, revenue by program, receivables aging, compliance %, retention year-over-year with cohort table).
3. Dashboards: console Home Action Center (all cards in `05 §5`), Money overview (gross, net, fees, refunds, disputes, outstanding, forecast from installments next 90 days), Registration overview, Compliance overview, Academy dashboard (Phase 12), Board report PDF (one-page season summary).
4. Website: port page editor/menus/theme; auto-generated pages (`02 §O`); news posts; sponsors; fundraisers; contact form; SEO (titles, descriptions, Open Graph images, sitemap.xml, robots.txt, structured data for events `SportsEvent`); subdomain routing; custom domain verification flow + operator docs; embeds; public pages respect visibility and media consent; performance (server-render public pages? — decision: public org pages are rendered by the SPA with a prerender step for SEO using server-side `react-dom/server` rendering of public routes in the API server; implement SSR for `/site` routes only).
5. Org data export (complete zip of CSVs per table the org owns + files manifest; step-up; 7-day signed link), privacy requests workflow (access export for a person/household, correction, deletion/anonymization per `04 §7`), retention policy page and sweep job.

### Acceptance criteria
- Report builder: registrar cannot add medical columns; finance can add payments; scheduled report emails a secure link; exported CSV neutralizes `=cmd` formulas.
- Public site Lighthouse (mobile): Performance ≥ 90, Accessibility 100, SEO ≥ 95 on the seeded org home, programs and schedule pages.
- Privacy deletion of a person anonymizes PII across tables while invoices and waiver signatures remain with pseudonymized subject; audit recorded.

---

## Phase 15 — Onboarding, imports, demo data, help, optional AI assist

### Tasks
1. Onboarding checklist for new orgs (persisted, dismissible): connect payments, set up users & roles, choose sports, create season/program (wizard), add facilities, configure compliance requirements, import members, publish website, open registration. Each item links to the exact screen and completes automatically when done.
2. Import framework extended (Phase 2 engine) to: registrations history (for returning-player detection), teams & rosters, schedules (port), facilities, credentials (with expiry dates and documents via zip), historical payments (for reporting only; marked `external`, not re-charged), volunteers hours. Presets: generic templates with downloadable sample CSVs; competitor presets only from real sample files (D17) — document how to add a preset.
3. "Switch to Athlentry" guide pages in the help center describing export steps from other platforms in general terms (no invented column names), plus a concierge-import request form that notifies platform staff.
4. Help center: in-app help drawer with articles (Markdown in repo, `docs/help/`, en/es for family-facing topics), contextual links from each console area, search, "Contact support" (creates a support ticket email to platform support address with org/context metadata, no Restricted data).
5. Deterministic seed profiles (`db:seed --profile demo|e2e|load`): (a) **Riverside Rec Soccer League** (league mode, 600 kids, U6–U14, 8 fields, volunteers, closures), (b) **Summit Volleyball Club** (club mode, tryouts, 24 teams, offers, team fees, tournaments), (c) **Northstar Gymnastics & Swim Academy** (class mode, 40 classes, tuition, skill levels), (d) **Metro Youth Sports Association** with 2 member clubs (federation, inter-club league, referee pool), (e) **Lakeside Wrestling & Track** (hybrid individual sports: duals, meets), (f) adult pickleball/softball rec league (adult accounts, team entries). All names fictional; emails at `example.test`; no real people.
6. Optional AI assist (entirely disabled unless `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` set; UI hides features when disabled; default model `claude-sonnet-5`, configurable via `AI_MODEL`):
   - **Form drafting**: admin uploads a PDF/DOCX/text of an existing paper form → proposed form fields (types, required, options, tiers) for review in the form builder; nothing saved without admin confirmation.
   - **Message translation**: English↔Spanish for campaigns and templates, shown as an editable draft.
   - **Family help assistant**: answers questions on the public site/portal using only that org's published content (program pages, schedules, FAQ/news pages, policies) retrieved server-side; cites the source page; refuses and offers "Contact the organization" for anything else; never receives personal data, never answers about specific children, balances or medical info; conversations stored 30 days for abuse review; rate-limited.
   - All prompts and outputs pass through a redaction step for emails/phones; audit usage per org; monthly usage cap per plan.

### Acceptance criteria
- A brand-new org completes the onboarding checklist end-to-end in Playwright (with stripe-mock) in one scripted run.
- Import of teams & rosters and credentials fixtures succeeds with previews and rollback.
- All seed profiles load in < 2 minutes and every console area renders non-empty for the matching org.
- AI features: with provider disabled, no AI UI is rendered and no network calls occur (test); with a fake provider, form drafting produces a draft requiring confirmation; the help assistant refuses a question about a named child.
