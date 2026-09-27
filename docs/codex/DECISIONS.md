# DECISIONS

> Codex: record every decision where the specification was silent, ambiguous or wrong. Format below. Never delete entries; supersede them.

## Template

### DEC-000 — Title
- **Date:**
- **Phase / area:**
- **Context:** what the spec said or did not say
- **Decision:**
- **Why:** (child safety → financial correctness → privacy → simplicity)
- **Consequences / follow-ups:**

---

(Decisions D1–D18 in `00-START-HERE.md §5` are pre-made by the owner's delegate and are not repeated here.)

### DEC-001 — Phase 0 shell has no inactive controls
- **Date:** 2026-09-26
- **Phase / area:** Phase 0 web
- **Context:** Phase 0 requires a sign-in page skeleton, while the project forbids dead buttons and links. Authentication arrives in Phase 1.
- **Decision:** Render the sign-in heading and an honest access status without form controls or navigation links until sign-in works end to end.
- **Why:** Simplicity and privacy; visitors cannot submit credentials into an unfinished flow.
- **Consequences / follow-ups:** Replace the shell with the fully functional sign-in flow in Phase 1 and capture legacy design references first.

### DEC-002 — Local database authentication
- **Date:** 2026-09-26
- **Phase / area:** Phase 0 tooling
- **Context:** The spec requires distinct app and admin roles but does not prescribe local credentials.
- **Decision:** Bind PostgreSQL to localhost and use trust authentication in Docker Compose only. CI uses its own ephemeral PostgreSQL password supplied by the CI service; production must use managed credentials.
- **Why:** Keeps local secrets out of the repository while retaining separate database privileges.
- **Consequences / follow-ups:** Phase 16 deployment must not use this Compose authentication model.

### DEC-003 — Empty tenant context fails closed
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 database isolation
- **Context:** PostgreSQL can retain an empty string for a transaction-local setting after commit. Casting that empty string directly to UUID makes a later query fail with a cast error.
- **Decision:** RLS policies use `NULLIF(current_setting('app.org_id', true), '')::uuid`. With no active tenant context, the comparison yields no rows and tenant writes fail. The fix is a forward-only migration.
- **Why:** Protects tenant privacy while making pooled connections safe to reuse.
- **Consequences / follow-ups:** Every future tenant policy must use the same expression, and the RLS coverage test must continue to run against the app role.

### DEC-004 — Restrict global table writes by database role
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 database permissions
- **Context:** Global plans and organizations have no tenant RLS; the specification assigns plan management to platform staff and requires records to be archived rather than hard-deleted.
- **Decision:** The app role can read plans and cannot write them. It can create and update organizations through the org module but cannot delete them. Platform staff writes to plans use the admin role.
- **Why:** Protects financial settings and prevents accidental deletion of organization records.
- **Consequences / follow-ups:** Platform plan management must use a narrow admin connection with explicit authorization and audit.

### DEC-005 — Reject ambiguous local times and protect leap-day birthdays
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 date utilities
- **Context:** The specification requires organization-timezone math but does not define how a local time in a DST gap or overlap is resolved, or when a February 29 birthday occurs in a nonleap year for age checks.
- **Decision:** A local date and time that maps to zero or two instants is rejected, so the caller must choose an unambiguous time. For age calculations, a February 29 birthday occurs on March 1 in nonleap years.
- **Why:** Prevents scheduling at an unintended instant and avoids approving a child account a day early.
- **Consequences / follow-ups:** Scheduling UI must explain invalid or ambiguous local times and request a different time or explicit offset.

### DEC-006 — Scope organization invitation tokens with RLS
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 identity schema
- **Context:** `02 §B` calls `auth_tokens` global but also gives it a nullable `org_id`; `01 §3` requires forced RLS coverage for every table containing `org_id`.
- **Decision:** Enable forced RLS on `auth_tokens`. The app role may access rows with no organization, and organization-linked rows only inside `withOrg`. The privileged admin role may access all rows for narrowly authorized token operations.
- **Why:** A leaked app-role query cannot enumerate invitations for other organizations.
- **Consequences / follow-ups:** Invitation issuance and redemption must use explicit organization context or a narrow audited admin operation; never query invitation tokens through a general unscoped app connection.

### DEC-007 — Bundled common-password blocklist
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 password policy
- **Context:** `01 §4` requires blocking the 10,000 most common passwords but does not name a source.
- **Decision:** Bundle SecLists' MIT-licensed `10k-most-common.txt` with its license in `docs/third-party/`. Password checks use the bundled list without a network dependency.
- **Why:** Authentication remains reliable in local, test and production environments, and rejected passwords are not sent to an external service.
- **Consequences / follow-ups:** Review and refresh the list during the Phase 16 security gate.

### DEC-008 — Auth token lifetimes beyond magic links
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 identity tokens
- **Context:** `01 §4` sets magic links to 15 minutes and one use, but does not set lifetimes for verification, reset, email-change or invitation tokens.
- **Decision:** Verification links expire after 24 hours; password-reset and email-change links after 1 hour; invitations and person-claim links after 7 days. Every token is one use and a resend revokes the previous live token for the same subject.
- **Why:** Limits the useful lifetime of a leaked link while allowing families enough time to accept invitations.
- **Consequences / follow-ups:** Email templates and UI must show the relevant expiry and offer a working resend path.

### DEC-009 — Account organization index for authentication
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 sign-in authorization
- **Context:** Global sign-in must detect elevated roles across organizations, while every membership and role query must run through `withOrg`. The specification does not provide a global locator for an account's organizations.
- **Decision:** A database trigger maintains `accounts.linked_org_ids` when a membership is created. Sign-in reads this account-level index, then checks memberships and roles separately inside `withOrg` for each linked organization.
- **Why:** Preserves tenant isolation without giving the sign-in service broad admin-role access to tenant rows.
- **Consequences / follow-ups:** Membership migrations and repair tools must preserve or rebuild the index; role policies must independently require MFA for elevated actions even if an index is stale.

### DEC-010 — Local legal drafts for consent capture
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 sign-up
- **Context:** Sign-up must capture the exact Terms and Privacy text accepted, while `13` schedules full legal drafts for Phase 16 and production requires legal review.
- **Decision:** Local sign-up uses versioned, clearly marked draft text now and stores its exact text in append-only consent rows. Production remains blocked until approved legal documents replace the drafts.
- **Why:** Allows the complete consent flow to be tested without presenting draft terms as approved production policy.
- **Consequences / follow-ups:** Phase 16 must replace the drafts with reviewable full documents and preserve older consent versions for evidence.

### DEC-011 — Activate pending roles after MFA confirmation
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 identity and roles
- **Context:** MFA factors are global account data, while role assignments are tenant data that must be updated through separate `withOrg` transactions.
- **Decision:** Confirm the factor and issue recovery codes in one account transaction, then activate each pending role in its organization-scoped transaction with an audit entry. Each activation is idempotent.
- **Why:** Prevents a role from becoming active before the factor is confirmed and preserves RLS for all role writes.
- **Consequences / follow-ups:** The HTTP flow must surface an activation failure and provide a retry path; sign-in must recheck pending roles after successful MFA so a partial activation can recover.

### DEC-012 — Local restricted-field key storage and auth transport
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 local auth runtime
- **Context:** Auth services require a persistent AES key for encrypted MFA secrets. The specification forbids committed secrets and real outbound delivery in local development but does not prescribe local key creation or cookie transport details.
- **Decision:** Create a random key once in the ignored `data/dev-encryption-key.json` with owner-only file permissions. Local auth uses Mailpit preview and an always-pass test captcha. Browser sessions use a Secure, HttpOnly, SameSite=Lax host-only cookie; mutating requests require the same-origin `Origin` and `X-Athlentry-Request` header. Production auth startup fails closed until approved legal documents and production adapters are configured.
- **Why:** Protects MFA secrets and browser sessions while keeping local flows reproducible without external delivery.
- **Consequences / follow-ups:** Implement real Turnstile and production adapters before the launch gate; verify local browser cookie behavior on desktop and mobile. Native bearer requests need a separately authenticated path that does not rely on browser Origin headers.

### DEC-013 — Unique device ownership and revoked subscription data
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 native auth and devices
- **Context:** The device-token model does not prescribe duplicate handling or what to retain after revocation.
- **Decision:** Hash each platform plus its stable endpoint/token as a unique fingerprint. The same account may refresh its registration; another account receives a conflict until ownership is resolved. Revocation retains the id and fingerprint for deduplication but clears the stored push subscription or token and marks the row revoked.
- **Why:** Prevents one device from receiving two accounts' notifications and minimizes retained delivery secrets after revocation.
- **Consequences / follow-ups:** Add an explicit verified device transfer flow if account switching on one device must be supported; push senders must filter revoked rows.

### DEC-014 — Additional public auth budgets and private limiter keys
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 public authentication
- **Context:** `01 §4` specifies sign-in, magic-link and recovery budgets but does not set sign-up or MFA-challenge limits or a key storage format.
- **Decision:** Apply 5 sign-ups/hour/IP and 8 MFA challenges/15 minutes/IP in addition to the specified limits. Hash normalized limiter keys with SHA-256 before writing them to the shared Postgres table. A limiter storage failure returns 503 rather than allowing unlimited attempts. The Postgres table is migration-owned; the library does not create schema at runtime.
- **Why:** Reduces automated account creation and MFA guessing while avoiding plain email/IP retention in limiter rows. Failing closed protects accounts when the limiter store is unavailable.
- **Consequences / follow-ups:** Schedule expiry cleanup with the Phase 1 job registry. Configure trusted proxy IP handling before deployment, and load real Turnstile credentials and widget before completing task 5.

### DEC-015 — Freeze legacy visual values before component work
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 design parity
- **Context:** `01 §11a` requires verbatim legacy tokens and reference screenshots, but recurring literal values had no property names and the old app is no longer the active checkout.
- **Decision:** Capture the fictional demo at revision `9ef77bb` in an isolated worktree at 1440px and 390px. Extract every custom property and frequently repeated literal color, spacing, type size, control height, radius and shadow into a frozen JSON snapshot and CSS variables. Add a unit test comparing the CSS variables with the snapshot after normalizing quote and whitespace formatting only.
- **Why:** Preserves the owner's chosen look as reviewable evidence while allowing the new components to share exact values.
- **Consequences / follow-ups:** Compare the rebuilt shell and component screenshots to the frozen images; any accessibility-driven visual change needs a narrow recorded exception.

### DEC-016 — Keep secure cookies in mobile browser tests
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 web authentication
- **Context:** WebKit discarded the required `Secure` session cookie over the plain HTTP e2e origin, so a successful sign-in could not load the account page. Repeated local e2e runs also exhausted persistent public auth rate limits.
- **Decision:** Run the e2e Vite server over local HTTPS using an ignored, generated self-signed certificate, and configure Playwright to trust that test origin. Keep the cookie flags unchanged. Clear only the global rate-limit table when seeding the isolated e2e database; use unique email addresses per browser run. Normal local development keeps its Phase 0 HTTP URL.
- **Why:** The mobile browser test exercises the production cookie security contract without weakening it, while rate-limit tests remain in the separate Postgres integration suite.
- **Consequences / follow-ups:** The e2e certificate and private key stay in ignored `data/`; production TLS terminates at the deployment edge. Add account security and org onboarding browser flows before Phase 1 acceptance.

### DEC-017 — Minimum touch targets on auth controls
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 design and accessibility
- **Context:** Legacy login controls are shorter than the `01 §11` 44×44 px touch target requirement. The extracted legacy tokens already include a 44px control height.
- **Decision:** Keep the legacy colors, borders, radii, fonts and widths, and use the existing 44px height token as the minimum for interactive auth buttons, inputs, selects, links, checkboxes and disclosures.
- **Why:** This is the smallest visual adjustment that makes auth controls meet the specified touch target size.
- **Consequences / follow-ups:** Design screenshot assertions may mask only the resulting control heights and downstream vertical shift; verify all other styling against the frozen legacy reference.

### DEC-018 — Local browser push registration without delivery
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 devices and public auth
- **Context:** Task 4 requires browser Web Push subscriptions while push delivery is scheduled for Phase 10. Task 5 requires Turnstile in production, while local and tests must use fake adapters. Neither a local VAPID key source nor a browser widget configuration route was specified.
- **Decision:** Generate a P-256 VAPID key pair once in ignored `data/dev-vapid.json` with owner-only permissions; expose only its public key. Register a minimal service worker and let authenticated browsers subscribe and revoke through the existing device API. Revoke the current browser's device record before sign-out or current-session revocation. Local sign-up receives a preview CAPTCHA mode; configured Turnstile mode renders an explicit widget with action `sign-up`, then the server validates its one-use token and hostname. Browser tests fake PushManager and never contact a push service.
- **Why:** Keeps device delivery identifiers controlled by the account, avoids exposing the VAPID private key, and maintains fake delivery and challenge behavior in local tests.
- **Consequences / follow-ups:** Production Turnstile keys and adapters remain unconfigured, and no push sender runs yet. Before Phase 10 push delivery, make server-side session expiry and revocation invalidate linked Web Push devices even when client cleanup cannot run. Add the PWA app-shell cache and manifest in task 16; verify a real browser subscription in a trusted HTTPS environment.

### DEC-019 — Organization seed records and an unpublishable waiver draft
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 organization onboarding
- **Context:** D7 gives Starter ($0/month, 150 bps), Pro ($99/month, 75 bps), and Enterprise (custom) but the plans table has no custom-price column. The onboarding spec requires a draft waiver that cannot be published until its example text is replaced.
- **Decision:** Seed the three plans as data. Enterprise has `limits.customPricing: true`, so no self-service checkout may use its zero placeholder price or fee values. Add tenant-scoped onboarding tables and a database constraint plus trigger that reject publication or review-clearing of the untouched default waiver text.
- **Why:** This keeps plan fees visible as data while preventing an accidental free Enterprise sale, and prevents an organization from publishing placeholder legal text.
- **Consequences / follow-ups:** Plan-change and billing code must explicitly reject `customPricing` plans until staff enter a reviewed contract price and fee schedule. The waiver editor must require a changed, reviewed body before clearing `template_unreviewed`. Sport templates, onboarding defaults, routes, and UI are next; task 6 remains unchecked.

### DEC-020 — Generated modules start inactive
- **Date:** 2026-09-26
- **Phase / area:** Track A module generator
- **Context:** The parallel plan requires a module generator but leaves its activation behavior unspecified. Its initial files cannot safely provide complete authorization, audited reads, schema constraints, or working UI without module-specific decisions.
- **Decision:** Generate `.template` files in the target module paths and reserve an available migration number in the caller's track range. The module author specializes and renames them before registry discovery or migration application. Refuse existing module directories and output overwrites.
- **Why:** Tenant privacy and financial correctness require reviewed database and permission behavior; inactive files also prevent unfinished controls from rendering.
- **Consequences / follow-ups:** Authors must resolve template tests, API wiring, audit rules and design components before activation. Verify the chosen migration number is still free when merging to trunk.

### DEC-021 — Safe onboarding defaults
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 organization bootstrap
- **Context:** The specification names default credentials, forms, season and settings but leaves their initial values open.
- **Decision:** Create a planning season for the organization's current calendar year; deny medical detail access to coaches by default; default media and communication consent off; require manual staff verification for the background check until a provider is configured. Create credential types as active blockers for staff roles, editable by the organization. Keep the default forms unpublished and the waiver unreviewed and unpublishable until its text changes.
- **Why:** Child safety and privacy favor restrictive defaults; no background-check provider or legal text is implied by a freshly created organization.
- **Consequences / follow-ups:** The Phase 1 settings and credential editors must let authorized staff configure these defaults, and onboarding must explain pending MFA and credential requirements.

### DEC-022 — Raw Stripe event ingestion is global
- **Date:** 2026-09-26
- **Phase / area:** Schema spine and finance
- **Context:** Stripe webhooks can arrive before an organization is resolved. The data model describes `stripe_events` as provider event storage but does not assign an organization to every event.
- **Decision:** Keep `stripe_events` global with its unique provider event identifier and immutable payload. Resolve the organization only when processing the event, then perform tenant reads and writes through `withOrg`.
- **Why:** Rejecting or misattributing an unresolved financial event risks incorrect charges and reconciliation. Global ingestion preserves the evidence without bypassing tenant isolation for business records.
- **Consequences / follow-ups:** The finance worker must restrict event access to its narrow processor, audit resolution failures, and never expose raw event payloads through tenant APIs.

### DEC-023 — Tenant-owned files and local access policy
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 files integration
- **Context:** The file adapter initially allowed nullable organization ids, while the global RLS invariant requires tenant-owned file records. The file service leaves authorization to the application composition root.
- **Decision:** Require `files.org_id` for every record. Local file routes require an authenticated active organization member and the request's organization header. Uploads require an active org-level owner, admin or registrar role with completed MFA; restricted downloads require owner or admin, sensitive downloads permit registrar, and internal/public downloads permit active members. Mutating routes verify origin and request header.
- **Why:** Privacy and child safety require an explicit tenant and narrow authorization before upload or download. Public website assets are published through a separate later flow.
- **Consequences / follow-ups:** Phase 1 file acceptance must verify these role boundaries over HTTP. Later public asset publishing must copy approved assets into a separate public delivery path without exposing private file URLs.

### DEC-024 — Separate campaign mail sender
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 email adapters
- **Context:** The spec requires branded organization messages and security mail but does not specify whether campaigns share the security sender domain.
- **Decision:** Keep a separately configured campaign sender domain in the Resend adapter. Local and test delivery use preview/fake adapters; no live delivery is enabled by this integration.
- **Why:** Separating bulk mail reputation from security mail protects verification and reset delivery.
- **Consequences / follow-ups:** Production adapter setup must verify both sender domains and their credentials before enabling delivery.

### DEC-025 — Guard editable safety requirements
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 organization onboarding
- **Context:** New organizations must be able to edit or disable default credential types. The initial verification method is manual staff review; other verification providers are not wired yet.
- **Decision:** Owners with completed MFA and recent step-up can edit the name, validity, activation blocking and active state with a version check. Show the verification method as read-only until a working provider workflow exists. Audit each change and hide another tenant's credential identifiers with 404.
- **Why:** This lets an owner control every default requirement while preventing a setting that claims to verify credentials through an unavailable provider.
- **Consequences / follow-ups:** Add selectable verification methods only with their complete review or provider workflow in a later phase.

### DEC-026 — Bind delivery devices to sessions
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 native and Web Push devices
- **Context:** An account-level device record could remain active after the session that registered it expired or was revoked.
- **Decision:** Bind new device registrations to the registering session, reject a concurrent stale session, hide expired-session devices from reads, scrub subscription or token data on explicit session revocation, and run hourly expiry cleanup. Revoke and scrub pre-migration device records that have no session association.
- **Why:** Delivery endpoints can identify a family's device; their validity must not outlast the authenticated session that supplied them.
- **Consequences / follow-ups:** Push dispatchers must select only active session-bound devices. A trusted HTTPS browser subscription check remains before Phase 1 task 4 is complete.

### DEC-027 — Serialize organization ownership changes
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 users and roles
- **Context:** Concurrent role edits could each observe another owner and leave an organization without an active owner. A direct role edit could also grant ownership without recipient acceptance.
- **Decision:** Add a membership version and lock the organization row before reading or changing owner assignments. Role edits require an active owner with completed MFA and recent step-up, reject direct owner grants, and revoke the target's sessions after any change. Granting admin or finance stays pending until MFA is confirmed.
- **Why:** A single serialization point protects the last-owner invariant, and accepted transfer prevents surprise legal and financial ownership.
- **Consequences / follow-ups:** The invitation and transfer flows must use the same organization lock. Add the users and roles screen and scoped role controls before task 7 is complete.

### DEC-028 — Restrict platform impersonation to scoped reads
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 platform console
- **Context:** The platform console can issue a 60-minute impersonation, but tenant routes need an explicit authorization and audit boundary.
- **Decision:** Require an active MFA-verified platform staff session, an active target organization, a valid unexpired impersonation ID, and an organization UUID in the tenant route. Permit GET/HEAD/OPTIONS only. Write the impersonation ID to platform and tenant audit ledgers before the read. Reject suspended-organization operations for active members and platform impersonators; reject unsupported unscoped tenant routes rather than inferring a tenant from a record ID.
- **Why:** Explicit scope and read-only enforcement prevent a support session from silently gaining write or cross-tenant access. Auditing before the read preserves evidence even when a downstream route denies access.
- **Consequences / follow-ups:** Future tenant routes without an organization ID need an explicit, tested impersonation policy before they can be accessed in this mode.

### DEC-029 — Keep suspension reversible and removal auditable
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 users and roles
- **Context:** The spec requires both suspension and removal of memberships but does not define whether role grants are retained for reactivation.
- **Decision:** Suspension preserves role assignments while denying effective access through inactive membership status; reactivation restores those assignments. Removal keeps the membership and audit history, revokes all active assignments and sessions, and requires a new invitation to rejoin. Both operations use membership versions and the organization-row lock to protect the last active owner.
- **Why:** A temporary safety or administrative hold can be reversed without reconstructing scoped access, while removal cannot silently reactivate old privileges.
- **Consequences / follow-ups:** Future permission checks must require active membership as well as an active assignment; the staff UI shows suspended memberships and hides removed ones.

### DEC-030 — Version scoped role changes with membership
- **Date:** 2026-09-26
- **Phase / area:** Phase 1 users and roles
- **Context:** A member can hold distinct grants for a season, program, division or team season. Editing one grant must not overwrite grants at other scopes or let an owner use an ID from another organization.
- **Decision:** Grant or revoke one scoped role at a time after checking the scoped entity under `withOrg`, with the same membership version, organization lock, owner step-up and target-session revocation as organization role edits. Ownership is restricted to organization scope and its separate accepted transfer flow.
- **Why:** Each change is independently auditable and concurrent edits cannot silently overwrite each other.
- **Consequences / follow-ups:** The staff UI lists tenant-scoped seasons, programs, divisions and team seasons by name; grants remain version-checked when those records change.

### DEC-031 — Transfer ownership only after recipient acceptance
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 users and roles
- **Context:** The spec requires owner-initiated, step-up protected transfer that the recipient accepts. It does not specify token lifetime or how concurrent changes invalidate a pending request.
- **Decision:** Send a single-use 24-hour transfer link to an active member's verified account. Acceptance requires that account's authenticated session and confirmed MFA; it checks both membership versions and both roles under the organization lock, grants the new owner first, revokes the previous owner's assignment, audits the action and revokes both accounts' sessions. A failed email send revokes the request.
- **Why:** Consent, identity and tenant checks precede the authority change; stale transfers cannot override later membership changes.
- **Consequences / follow-ups:** A changed membership requires a new request. The recipient signs in again after accepting because both sessions are revoked.

### DEC-032 — Keep organization branding separate from the admin chrome
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 organization profile
- **Context:** Organization branding must be editable, while the owner's existing web design system is fixed. The spec leaves default brand colors and URL validation open.
- **Decision:** Store a tenant's primary and accent colors for public and communication surfaces without changing admin UI tokens. Use the frozen blue values as defaults, require each color to reach 4.5:1 contrast on white, and accept HTTPS website URLs. Logo changes require a completed same-organization image from the files module and a version-checked owner profile update.
- **Why:** This preserves design parity and prevents unsafe URLs, unreadable brand text and cross-tenant or incomplete logo attachment.
- **Consequences / follow-ups:** Public site and email rendering use these brand values when their phases land; the admin console keeps `tokens.css` values.

### DEC-033 — Preserve SMS consent evidence and global STOP state
- **Date:** 2026-09-26
- **Phase / area:** Phase 10 communications consent
- **Context:** The spine stores account/phone data and tenant suppressions, but it has no versioned SMS consent evidence and its suppression policy permits global reads but not global signed STOP writes.
- **Decision:** Record SMS consent as append-only, tenant-scoped events containing the exact disclosure, version, phone, account, timestamp, IP and user agent. A verified Twilio STOP creates a global SMS-only suppression; signed START removes that global STOP row and appends a new consent event with the inbound text as evidence.
- **Why:** SMS delivery must fail closed without explicit, auditable consent, and STOP must take effect across every organization immediately.
- **Consequences / follow-ups:** Restrict global suppression writes to signed SMS webhook code; keep all tenant reads/writes inside `withOrg`; apply shared quiet-hours policy at delivery time.
