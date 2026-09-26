# Foundation remaining-work audit — September 12, 2026

> Historical pre-handoff audit. Administrator access, existing-member activation, clean initialization and permission cleanup have since been implemented. Use [FOUNDATION-REVIEW.md](FOUNDATION-REVIEW.md) for the current remaining acceptance scope; do not rebuild the completed items below.

## Scope and evidence

The target is a dependable sports-management foundation that can evolve into an original product. LeagueApps feature and visual parity are not acceptance criteria. This audit inspected the current route table, navigation, member portal, account APIs, team/staff permissions, messaging/delivery implementation, startup, and existing verification records. The current full suite passes 158 tests; the production build passes with a bundle-size advisory. Earlier browser route and mobile checks are recorded separately; this audit does not claim a new screenshot review of every screen.

## Existing screens — do not rebuild

- Dashboard; programs/list/summary/create/edit; program options, payment plans, questions, waivers, people, staff, teams, schedule, standings.
- Members/list/create/edit/profile; households; member profile fields and completion settings.
- Teams/list/profile/editor, roster building/settings and print views; locations and sub-locations; scheduling and CSV import; attendance.
- Invoices/detail/offline receipts, discounts, credits, installment reporting; registration cancellation, reenrollment and transfers.
- Products/edit/variants/categories/store management, public shopping and member orders, order detail/fulfillment/cancellation.
- Message compose, contacts, templates, sent/tracking views, email/SMS settings.
- Website pages/editor/menu/mobile homepage/branding; public pages/programs/calendar/locations/store and restricted content.
- Organization settings, registration settings, staff roles, terminology, standings settings.
- Member signup/login/verification/recovery, dashboard/family/profile, enrollment, schedules, teams, invoices, orders and password settings.

Every currently advertised main-navigation path has a corresponding screen. `/calendar` shares the schedule component; program-type menu entries filter the programs screen. The wildcard route remains a generic unfinished/unavailable screen; that alone does not mean a menu destination is missing.

## Foundation work that should be completed

### 1. Administrator access management

There is no administrator user-management/invitation screen or administrator password recovery/change flow. Admin authentication currently exposes login/logout, and starter access comes from seeded users. Staff Roles configures participant/coaching roles; it is not console-user management.

Provide an owner-facing user list, invite/add-access flow, role changes, deactivate/revoke access and session revocation. Protect the last owner from removal. Provide administrator password change/recovery. Verify owner/admin/manager/reporter permissions through actual screens as well as API tests. This is necessary to operate beyond one seeded administrator.

### 2. Access for existing member records

Signup rejects emails already present in `people`, `member_accounts` or `users`. Recovery only serves an existing member account. An adult added by an administrator can therefore have a profile without a supported route to activate their member login.

Provide an organization-controlled invitation/activation flow linking the verified adult to the intended existing profile. Include expiration, one-time use, resend/revoke and duplicate handling. Never allow claiming an arbitrary family or existing profile merely by typing its email. Verify family relationships and private record access after activation.

### 3. Honest team and staff permissions

CaptainFields explicitly disables invitations, direct player registration and manual additions. MemberTeams currently exposes roster viewing and permitted name editing. Several staff-role switches (invitations, roster submission, managed fields, score editing/evaluation) exist as stored configuration without corresponding complete member workflows.

For the foundation, keep roster administration in the console where it already works. Hide or clearly disable unsupported switches and explain the supported permissions; do not build all missing captain features just for parity. If captain self-service is selected as a foundation requirement, implement invitations, acceptance and roster permissions as one connected workflow. Evaluation remains deferred. Audit every displayed permission against its server enforcement and reachable UI.

### 4. Finish connected acceptance, not another feature expansion

Outstanding specific checks include:
- Transfer success with required destination answers/acceptance, retained source evidence and correct destination evidence.
- Transfer changed-form/price rejection, refreshed review and interrupted-response result lookup from the UI.
- Complete member recovery acceptance/sign-in, supplementing existing HTTP coverage and request/invalid-link browser checks.
- One final connected regression pass across program setup, family enrollment, roster assignment, billing, scheduling/results and storefront/order lifecycle after the latest shared changes. Reuse prior evidence and fixtures; do not repeat every isolated test indefinitely.
- Verify the advertised permission roles, empty/error states, keyboard navigation and key forms at desktop and phone widths. Route loading alone does not verify a form or a financial action.

### 5. Bounded interface cleanup

Teams, programs, invoices and recovery have sampled mobile checks and fixes. A complete visual acceptance record does not yet exist for all major screen families. Review member/family details, program editors, rosters, schedule dialogs, financial details, order forms, messaging, website editing and settings. Fix overlaps, unreadable wrapping, clipped actions, modal scrolling and missing feedback. Intentional contained horizontal table scrolling is acceptable. Do not adjust spacing merely to resemble LeagueApps.

Replace the generic unknown-route message with a useful unavailable/not-found state. Remove stale claims that partial capabilities work. Keep one current acceptance document; older replication logs must remain historical.

### 6. Normal setup without relying on demo records

Startup currently seeds an empty database. Provide a documented way to initialize a real organization and first owner without fictional sample records; retain a separate demo mode. Verify startup from a clean database. This complements administrator management and is distinct from a full multi-organization SaaS onboarding/billing system, which is not required now.

## Required before real customer launch, not before a local development foundation

- Account-email delivery: configure and verify provider credentials, sender/domain and HTTPS link origin; development links are not email delivery.
- Real payments: hosted checkout/provider integration, verified/idempotent webhooks, failed/pending outcomes, refunds and reconciliation. Current receipts, invoice balances and installment records do not move money. Autopay/online-required plans remain unavailable until implemented.
- Operational messaging: configure email/SMS, schedule the delivery worker, reconcile Unknown/Processing outcomes, consume delivery callbacks if status is advertised. Current held queues and adapters exist, but live delivery is not operational. Do not release fictional verification messages.
- Hosting: domain/HTTPS, production secrets, secure cookies, deployment process and smoke checks, logging/error monitoring, persistent storage and scheduled protected off-machine backups. Local backup/restore has already passed; remote operations have not been set up.
- Review real privacy/consent/waiver content and policies before collecting real participant data. Fictional verification documents are not launch documents.

## Missing or partial screens that can stay deferred

| Area | Present state | Foundation decision |
|---|---|---|
| Bookings/facility reservations | No complete booking workspace | Defer |
| Tryouts/evaluation | Partial backend creation/configuration; no complete operational UI/scoring flow | Defer |
| Advanced reporting workspace | Specific basic reports exist; no comprehensive custom analytics workspace | Defer |
| Gateway/transactions dashboard | No full payment-provider operational dashboard | Defer until live payments |
| Partner integrations/API management | Not offered as complete supported screens | Exclude copied partners; design own integrations later |
| Alternate themes/skins/widgets/editors | Core website editor exists; alternative systems incomplete | Defer |
| Captain invitations/roster submission/scorekeeping | Partial permissions, incomplete member actions | Hide/disable for admin-led foundation, or deliberately scope later |
| External-team management/print logos | Standings screen explicitly identifies unavailable features | Defer |
| Advanced commerce conveniences | Purchase notifications/mandatory add-ons and expanded reporting need separate scope checks | Defer unless required by the chosen launch workflow |

## Finish line

Complete administrator access, existing-member activation, clean initialization, honest permission controls, and the finite connected/visual acceptance pass. Keep provider launch requirements explicit. Do not add bookings, tryouts, advanced analytics, integrations or a redesign to this finish line without a new product decision.
