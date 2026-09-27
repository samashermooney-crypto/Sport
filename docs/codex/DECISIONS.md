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
- **Decision:** Require `files.org_id` for every record. Local file routes require an authenticated actor in the organization and the request's organization header. General uploads require an active org-level owner, admin or registrar role with completed MFA. A verified active guardian link may upload restricted evidence only for its represented person and an approved credential or return-to-play clearance purpose. Restricted downloads require an active owner or compliance role with completed MFA and an audited content read; sensitive downloads permit registrar, and internal/public downloads permit active members. Mutating routes verify origin and request header.
- **Why:** Privacy and child safety require an explicit tenant and narrow authorization before upload or download. Public website assets are published through a separate later flow.
- **Consequences / follow-ups:** Phase 1 and Phase 7 file acceptance must verify these role boundaries over HTTP, including guardian ownership and 404 denial for unauthorized Restricted reads. Later public asset publishing must copy approved assets into a separate public delivery path without exposing private file URLs.

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

### DEC-033 — Fail closed on production auth configuration
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 public authentication
- **Context:** Local auth uses preview email and an AlwaysPass CAPTCHA; production needs explicit delivery and Turnstile configuration. Expired PostgreSQL rate-limit rows otherwise accumulate indefinitely.
- **Decision:** Production startup requires approved legal documents, a strong session secret, HTTPS app URL, live delivery mode, database and encryption settings, Resend sender, Turnstile site and secret keys, and a VAPID public key. It uses server-side Turnstile verification and the configured Resend sender. An hourly registered worker job deletes only expired rate-limit rows; unexpired counters remain intact.
- **Why:** Missing protection or credentials cannot silently fall back to local adapters in production, while scheduled cleanup bounds storage without resetting active limits.
- **Consequences / follow-ups:** Deployment must provide these values before startup. Local development and tests continue to use preview/fake delivery; production service calls are not exercised in tests.

### DEC-034 — Meet contrast minimums in calendar and pagination text
- **Date:** 2026-09-26
- **Phase / area:** Track D shared design system
- **Context:** The legacy muted text colors for outside-month dates and pagination details fall below the required 4.5:1 contrast on their backgrounds.
- **Decision:** Use the existing `--muted` token for those two text treatments while leaving the token palette unchanged.
- **Why:** Accessibility is the only permitted visual adjustment under `01 §11a`; using the existing muted hue is the smallest passing change.
- **Consequences / follow-ups:** These two labels are slightly darker than legacy; all remaining captured token values and component styling stay unchanged.

### DEC-035 — Preserve modal styling while meeting phone touch targets
- **Date:** 2026-09-26
- **Phase / area:** Track D shared design system
- **Context:** The legacy admin modal close control is 32px square, while `01 §11` requires 44×44px touch targets. The admin modal reference uses a 68px title bar.
- **Decision:** Keep the 32px close affordance on desktop. On phone widths, expand its control box to 44×44px and reduce title-bar vertical padding so the captured title-bar height remains unchanged; retain the legacy icon, colors, border and typography.
- **Why:** This satisfies the explicit touch target requirement with the smallest mobile-only change to the legacy modal.
- **Consequences / follow-ups:** Phone screenshots include the wider invisible close-control area; modal styling otherwise follows the captured admin modal treatment.

### DEC-036 — Correct empty-state copy contrast
- **Date:** 2026-09-26
- **Phase / area:** Track D shared design system
- **Context:** The legacy empty-state copy color fails the required contrast check on a white panel, surfaced by the design parity axe audit.
- **Decision:** Use the existing `--muted` token for shared empty-state copy while preserving its size, layout and surrounding styles.
- **Why:** Accessibility is the only permitted visual adjustment under `01 §11a`; the existing muted token is the smallest passing change.
- **Consequences / follow-ups:** Empty-state copy is darker than the original legacy color; the palette and all other captured values stay unchanged.

### DEC-037 — Enumerate account organizations through the identity index
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 organization switcher
- **Context:** Tenant rows cannot be scanned without an organization scope, while an account needs to list its own organizations.
- **Decision:** Read only the signed-in account's global `linked_org_ids` index, then enter `withOrg` separately for each ID and include only active memberships in active or onboarding organizations. A workspace summary also reads roles inside `withOrg` and exposes only actions that the account can actually use.
- **Why:** Account-specific discovery does not bypass tenant RLS or expose a removed, suspended or unrelated organization.
- **Consequences / follow-ups:** The console switcher uses this list; every newly linked organization continues to update the account index through the existing membership trigger.

### DEC-038 — Cap transfer reversals at recoverable Stripe funds
- **Date:** 2026-09-27
- **Phase / area:** Phase 4 disputes and transfer reversals
- **Context:** A disputed charge plus dispute fee may exceed the connected transfer amount that Stripe permits reversing.
- **Decision:** Reverse only the remaining unreversed transfer amount and record any shortfall as unrecovered platform liability. A later dispute win restores only funds actually reversed.
- **Why:** The ledger must never claim that Stripe moved money it could not reverse.
- **Consequences / follow-ups:** Reconciliation and payout reports must show the outstanding liability until a real recovery is recorded.

### DEC-039 — Freeze refund terms when an invoice is issued
- **Date:** 2026-09-27
- **Phase / area:** Phase 4 invoice refunds
- **Context:** Organization or program refund settings can change after an invoice is issued.
- **Decision:** Persist the applicable refund policy, approval threshold and fee terms with the invoice at issuance. Refund calculations use that immutable snapshot.
- **Why:** A later setting edit must not retroactively change a family's refund rights or the finance ledger.
- **Consequences / follow-ups:** Historical invoices need an explicit policy snapshot before staff refund actions are enabled; unsupported mixed-payment allocations fail closed.

### DEC-040 — Sanitize document photos as images
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 files
- **Context:** The files module accepted JPEG/PNG document uploads but only re-encoded the `image` and `website_asset` purposes. A document photo could therefore preserve GPS metadata.
- **Decision:** Re-encode every accepted image MIME type, including document photos, and store the sanitized WebP original and derivatives. Leave PDF and import bytes unchanged.
- **Why:** A file's purpose does not reduce the location privacy risk of embedded image metadata.
- **Consequences / follow-ups:** Document photo downloads return `image/webp`. A committed GPS-tagged JPEG fixture verifies that the original and both stored variants have no EXIF, XMP or IPTC metadata.

### DEC-041 — Select the initial web language from a local preference
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 frontend internationalization
- **Context:** The web app needs an initial language before authentication, when no account preference is available.
- **Decision:** Use a saved explicit English or Spanish choice when available, then the browser language, then English. Update the document language when the user switches and continue rendering if browser storage is unavailable.
- **Why:** A choice made on the sign-in screen should survive navigation, while private-browsing storage failures must not block access.
- **Consequences / follow-ups:** Account preference synchronization and complete auth/portal/site translations remain part of Task 16.

### DEC-046 — Preserve SMS consent evidence and global STOP state
- **Date:** 2026-09-26
- **Phase / area:** Phase 10 communications consent
- **Context:** The spine stores account/phone data and tenant suppressions, but it has no versioned SMS consent evidence and its suppression policy permits global reads but not global signed STOP writes.
- **Decision:** Record SMS consent as append-only, tenant-scoped events containing the exact disclosure, version, phone, account, timestamp, IP and user agent. A verified Twilio STOP creates a global SMS-only suppression; signed START removes that global STOP row and appends a new consent event with the inbound text as evidence.
- **Why:** SMS delivery must fail closed without explicit, auditable consent, and STOP must take effect across every organization immediately.
- **Consequences / follow-ups:** Restrict global suppression writes to signed SMS webhook code; keep all tenant reads/writes inside `withOrg`; apply shared quiet-hours policy at delivery time.

### DEC-047 — Treat registration and balance as audience refinements
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 campaign audience
- **Context:** `AudienceSpec` defines include/exclude selectors but does not define how registration status and balance combine with a team, program or role selection.
- **Decision:** Include selectors form the candidate audience, exclusions remove matches, then registration status and past-due balance refinements narrow the remaining audience. A past-due balance matches only the invoice's bill-to account; other guardians are not shown or sent account-specific balance messages.
- **Why:** This gives predictable U10-plus-past-due targeting and protects household financial privacy when an athlete has multiple guardians.
- **Consequences / follow-ups:** Keep filters inside the tenant-scoped audience resolver and cover payer-only routing with database-backed tests.

### DEC-048 — Link in-app campaign deliveries to their inbox notification
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 in-app delivery
- **Context:** A campaign's in-app channel creates a Track B inbox notification, while the delivery spine requires exactly one of `campaign_id` or `notification_id`; storing both links would fail the existing constraint.
- **Decision:** Keep source exclusivity for email, SMS, push and standalone notification deliveries. Permit both source links only for `in_app` campaign delivery so its campaign stats and Track B inbox/SSE event share one delivery record.
- **Why:** The one-row link preserves campaign stats and retry idempotency while reusing Track B's inbox and stream service.
- **Consequences / follow-ups:** The allowed dual link is constrained to `in_app` and covered by a database-backed integration test.

### DEC-049 — Require an explicit program setting for athlete team chat
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 team conversations
- **Context:** The Phase 10 team roster includes athletes aged 13+ only "if enabled," but the schema and UX do not name a setting or default.
- **Decision:** Keep athlete accounts out of team conversations unless `programs.settings.communications.athleteChatEnabled` is exactly `true`. Continue to include active team staff and guardians for every minor; additions run through the shared SafeSport policy. The default is off.
- **Why:** Youth accounts should not become visible in a staff/family communication channel until an authorized organization setting explicitly enables that audience.
- **Consequences / follow-ups:** Track A must expose this setting in program/team communication settings. H's team conversation service reads the setting and is covered by a database-backed membership test.

### DEC-050 — Soft-revoke chat membership when team eligibility changes
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 team conversation membership
- **Context:** Roster, staff assignment, guardian link, or athlete-chat setting changes can make a previously included account ineligible, while chat history must remain retained.
- **Decision:** Keep conversation membership rows and message history, mark ineligible members with `revoked_at`, and filter revoked rows from access, recipient, unread and read-receipt queries. Team and staff conversation synchronization applies both additions and revocations through the shared SafeSport policy and audits the membership delta.
- **Why:** Removed families and staff immediately lose access without erasing retained messages or compliance evidence.
- **Consequences / follow-ups:** Track A must invoke the H synchronization functions after roster and staff assignment changes; the service reconciles the active membership set.

### DEC-051 — Show attachment actions only for current Files access
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 chat attachments
- **Context:** Track C's Files routes currently require active organization membership for all access and owner/admin/registrar for upload, while household portal access can come from person-account links alone.
- **Decision:** The chat API reports attachment capabilities using the current Files authorization contract. The portal renders upload/download actions only when those capabilities allow them; chat messages remain visible with a neutral access-unavailable label otherwise.
- **Why:** A family-facing button that predictably receives 403 is not a working feature, and membership must not grant file access outside the Files policy.
- **Consequences / follow-ups:** Track C must extend Files upload/download authorization to active same-organization conversation members for approved chat image/PDF attachments; then remove any stale capability duplication if Files exposes an authorization API.

### DEC-052 — Measure the web entry chunk separately from lazy area chunks
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 bundle budget and Track H integration
- **Context:** The build generated an entry chunk and a separate lazy shared UI chunk, both named `index-*.js`. The existing size-limit glob summed them as one entry after message routes were mounted.
- **Decision:** Name the actual Vite entry `app-*.js`, keep lazy chunks separately named, and apply the 200 KB gzip entry budget to `app-*.js`. Lazy message screens load on their routes.
- **Why:** This measures the specification's entry budget without treating route-level code as initial JavaScript.
- **Consequences / follow-ups:** The merged entry is 173 KB gzip; area chunks remain below their 250 KB gzip budget and must continue to be checked as new routes land.

### DEC-053 — Localize generic account request confirmations in the browser
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 auth i18n
- **Context:** Password-reset, magic-link and sign-up endpoints deliberately return generic confirmations to prevent account enumeration. Their English message bodies would remain untranslated when a user selects Spanish.
- **Decision:** Show a fixed, translated generic confirmation for each successful request in the browser. Keep the server's generic response behavior and preserve error details for diagnosis.
- **Why:** Both languages communicate the same privacy-preserving outcome without leaking whether an address has an account.
- **Consequences / follow-ups:** Localize remaining auth screens and server-provided legal text before Task 16 acceptance.

### DEC-054 — Preview draft campaign audiences without persisting campaign state
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 campaign composer
- **Context:** The composer needs a live recipient count while staff change selectors, categories and channels before saving a campaign.
- **Decision:** Use a read-only draft audience preview endpoint backed by the same recipient resolver and channel eligibility calculation as saved campaign preview. Require campaign permissions and owner/admin authorization for emergency audiences; debounce composer requests and skip preview until a selector and channel are present.
- **Why:** Staff can check routing while editing without persisting every draft and preview counts remain aligned with send-time policy.
- **Consequences / follow-ups:** Cover saved and unsaved preview paths with tenant and permission integration tests.

### DEC-055 — Generate weekly installments on the checkout weekday
- **Date:** 2026-09-27
- **Phase / area:** Phase 4 installments
- **Context:** `02 §L` lists weekly plans, while `20 §3` specifies dates only for fixed-date and monthly schedules.
- **Decision:** A weekly template takes a positive installment count. The first charge is seven calendar days after the organization-local checkout date, with later charges at seven-day intervals on the same weekday. Deposit, cent allocation and minimum-charge reduction follow the existing installment rules.
- **Why:** This gives `weekly` a deterministic schedule without inventing another day-of-week or interval setting.
- **Consequences / follow-ups:** Finance template validation and quoting should accept `{ kind: 'weekly', count }` and use the shared generator; a later custom cadence needs an explicit schema and decision.

### DEC-056 — Store the exact localized consent draft shown at signup
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 identity and internationalization
- **Context:** Sign-up offered a Spanish interface but served and saved only the English legal drafts. The consent record must retain the exact document displayed to the account holder.
- **Decision:** Serve the current English or Spanish draft from `/api/v1/auth/legal?locale=`, using English for unknown values. Assign the Spanish draft its own version and save its full text with the selected locale during sign-up. Both drafts remain clearly labeled for legal review.
- **Why:** The consent audit trail must match the language and wording the person saw before accepting.
- **Consequences / follow-ups:** A qualified legal reviewer must replace and approve both language versions before launch; publish future revisions as distinct immutable versions.

### DEC-057 — Save account language separately from the browser preference
- **Date:** 2026-09-27
- **Phase / area:** Phase 1 internationalization and Phase 10 SMS consent
- **Context:** The browser's local language choice could differ from the account locale used to choose an auditable SMS consent disclosure.
- **Decision:** Return the saved `en`/`es` account locale from `/api/v1/auth/me` and let an authenticated account update it through a versioned API route. The account page follows the saved locale, and a successful language change updates both the account and browser preference.
- **Why:** The displayed account language and the server's SMS consent version need one durable source of truth across devices.
- **Consequences / follow-ups:** Authenticated portal and platform entry points should load the account locale before rendering consent-bearing content; the public unauthenticated experience continues to use the browser preference.
### DEC-058 — Compare compliance dates as organization calendar dates
- **Date:** 2026-09-27
- **Phase / area:** Phase 7 credential eligibility and expiry
- **Context:** PostgreSQL `date` values are returned through the driver as JavaScript `Date` objects; comparing those instants against an organization-local calendar day can shift eligibility at timezone boundaries.
- **Decision:** Convert stored dates to `YYYY-MM-DD` values and compare them as SQL `date` values for eligibility, overrides and expiry.
- **Why:** Credential and FCRA deadlines are calendar dates, not UTC instants.
- **Consequences / follow-ups:** Tests cover timezone-safe expiry, credential review and override boundaries.

### DEC-059 — Accept linked guardian injury reports
- **Date:** 2026-09-27
- **Phase / area:** Phase 7 injuries and return to play
- **Context:** The family portal presents injury reporting for a linked athlete, while the Phase 7 text does not narrow reporting to staff.
- **Decision:** Permit a verified self or guardian link to submit and read that person's injury record; encrypt the narrative, write Restricted-read audits, notify guardians, and automatically hold rosters for suspected concussion reports.
- **Why:** Families need a direct safety reporting path and concussion holds must not wait for staff review.
- **Consequences / follow-ups:** Staff still review return-to-play evidence before roster restoration; role authorization remains tenant-scoped.

### DEC-060 — Associate restricted uploads with the represented person
- **Date:** 2026-09-27
- **Phase / area:** Phase 7 credential evidence
- **Context:** Restricted file IDs are opaque, but a same-organization file ID could otherwise be attached to another person's credential.
- **Decision:** Credential evidence must be a completed restricted file whose owner type is `person_credential` and owner id is the credential subject. The Files module must authorize guardian uploads and compliance reviewer downloads with its own audited policy.
- **Why:** Organization scope alone does not prevent one person's protected document from appearing on another person's safety record.
- **Consequences / follow-ups:** Track C must extend the Files module's current owner/admin-only access without weakening its tenant, consent, or audit checks.

### DEC-061 — Keep volunteer-paid background checks disabled without invoicing
- **Date:** 2026-09-27
- **Phase / area:** Phase 7 FCRA configuration
- **Context:** The settings contract includes a volunteer-paid fee option, but the finance invoice service is not yet available to Track F.
- **Decision:** Reject enabling volunteer-paid mode until Track E exposes an invoice-backed flow; manual and configured Checkr checks remain available without collecting money.
- **Why:** A background-check flow must not collect or promise a fee without an auditable invoice and reconciliation path.
- **Consequences / follow-ups:** Track E can unblock the option by providing its documented invoice service; no live payment path is introduced here.

### DEC-062 — Use the organization calendar for People age and grade
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 People directory
- **Context:** The data model stores graduation year but leaves the school-year rollover for directory grade unspecified.
- **Decision:** Calculate current age on the organization's local calendar date. Calculate grade from graduation year with an August 1 school-year rollover, stored as `peopleSchoolYearCutoff` in organization settings for later configuration. Never store the derived age or grade on a person.
- **Why:** This keeps directory and eligibility values current across birthdays and school years without bulk data updates.
- **Consequences / follow-ups:** Filters use the same local date and cutoff. A later organization settings control can expose the cutoff after its validation and audit flow is built.

### DEC-063 — Batch outbound unread chat fallback per conversation
- **Date:** 2026-09-27
- **Phase / area:** Phase 10 chat notifications
- **Context:** Busy conversations can produce repeated push and email alerts, while chat itself must remain realtime over Track B's inbox/SSE path.
- **Decision:** Keep the per-message in-app/SSE notification immediate, and batch only external unread fallback by organization, conversation and recipient for ten minutes from the first message. Recheck active membership, mute and unread state at dispatch; send push when enabled and use email only when push is unavailable; never include chat body text. Push delivery follows the shared quiet-hours policy.
- **Why:** Families keep realtime chat while notification bursts are reduced, read conversations do not produce stale fallback, and message content stays out of external notification bodies.
- **Consequences / follow-ups:** H stores retryable tenant-scoped batch state in migrations `4005`–`4006`; preference defaults and channel selection come from Track B. Provider failures retry with bounded backoff.

### DEC-070 — Keep household primary contacts and balances explicit
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 households
- **Context:** The data model allows multiple households per person and invoices in different currencies; the task does not define primary-contact replacement or balance aggregation.
- **Decision:** A household may have one primary contact, who must have an adult household role. Adding a new primary contact clears the former flag in the same locked transaction. Show invoice balances grouped by currency and never add amounts from different currencies.
- **Why:** The rule prevents ambiguous contact routing and misleading financial totals.
- **Consequences / follow-ups:** Member editing and removal must preserve or deliberately reassign the primary contact. Household address and membership changes are audited and versioned.

### DEC-071 — Retain removed household membership history
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 household membership
- **Context:** A household member can hold encrypted custody notes and financial responsibility; deleting the row would erase context needed for audits and could leave authorization consumers trusting a stale link.
- **Decision:** Set `removed_at` on removal and retain the row. Re-adding the same person creates a new active membership. Every family, chat, checkout and finance authorization query ignores removed memberships. Removing the last primary contact while other members remain requires another adult to be assigned first.
- **Why:** Historical contact decisions remain reviewable while access ends immediately.
- **Consequences / follow-ups:** New membership consumers must filter on `removed_at IS NULL`; membership removal and reassignment are covered by PostgreSQL and browser tests.

### DEC-072 — Keep People balance filtering tied to direct invoice lines
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 People directory
- **Context:** A person may belong to several households, while a household invoice can contain charges for several people. The directory's `has balance` filter does not define whether a family debt belongs to every member.
- **Decision:** Count a person as having a balance only when an outstanding, non-draft, non-void invoice contains a line assigned to that person. Household filtering uses active membership only; a removed membership does not appear in results.
- **Why:** This avoids attributing a sibling's or guardian's debt to a child and prevents a removed relationship from keeping someone in a household result.
- **Consequences / follow-ups:** Unassigned invoice lines do not make every member appear indebted. The People directory can still show household-wide balances separately in the household view.

### DEC-073 — Use current participation for People program and team filters
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 People directory
- **Context:** Registration and roster history is retained after withdrawal and release, but the directory's program and team filters do not specify whether former participants should remain in results.
- **Decision:** A program filter matches a registration that has not been canceled, withdrawn or transferred out. A team filter matches a current roster entry with active, injured or suspended status and no departure date. Staff search organization programs and team seasons by name, with team labels including their program.
- **Why:** This makes the directory useful for current operations while keeping historical participation available in the underlying records.
- **Consequences / follow-ups:** Historical participation needs a separate history view rather than broadening these current-participant filters.

### DEC-074 — Retire person photos when media consent ends
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 People photos
- **Context:** A person's photo can remain in the file store after consent changes, and the generic file endpoint can issue a download link independently of the People profile.
- **Decision:** Staff attach only a completed image file with sensitive classification and exact person ownership after media consent is granted. The browser crops to a square before upload. Removing or replacing a photo, or revoking consent, clears the profile link and soft-deletes the old file record in the same org transaction. Person responses suppress photo IDs whenever consent is not granted.
- **Why:** The file cannot be newly downloaded after consent revocation, while the audit and file metadata remain reviewable.
- **Consequences / follow-ups:** Previously issued external presigned URLs may remain valid until their five-minute expiry. The family portal photo editor must reuse the same consent and ownership checks when Phase 2 guardian access lands.

### DEC-075 — Label the People compliance filter by credential record state
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 People directory
- **Context:** A person may have multiple credentials, while eligibility depends on role, program, age, expiry, requirements and overrides. A single `compliant` flag in the directory could incorrectly imply permission to coach or officiate.
- **Decision:** Offer exact credential-record states (`pending_review`, `verified`, `rejected`, `expired`, `revoked`) plus no record. A person can match more than one state. Label the control “Compliance credential status,” and continue to use the Phase 7 role policy for activation decisions.
- **Why:** Staff can find records needing review without treating a verified credential as proof that all role requirements are satisfied.
- **Consequences / follow-ups:** The Phase 2 task remains open until the role-aware compliance view and remaining acceptance criteria are complete.

### DEC-076 — Verify adult guardian accounts before direct staff linking
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 guardian links
- **Context:** Staff may link an existing account to a person by email, which immediately grants access to protected child records. A shared, unverified, suspended or minor account must not gain guardian access.
- **Decision:** Direct linking resolves only an active, email-verified account whose date of birth proves age 18 or older in the organization's timezone. The person must be active and belong to that organization. A duplicate active link is rejected, every link/revocation is audited, and revoking the final verified guardian of a minor with a self account is blocked.
- **Why:** Staff linking is an explicit authorization action, but account control, adult status, tenant scope and continuing supervision must still be checked at the time of change.
- **Consequences / follow-ups:** Guardian invitation redemption repeats these checks and binds its token to the intended person and email. Athlete and adult self-claim flows remain before Phase 2 task 3 can close.

### DEC-079 — Discover family organizations through an account candidate index
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 family portal
- **Context:** A guardian may have people in several organizations without an organization staff membership. A cross-tenant family listing must find candidate org IDs without querying tenant rows outside `withOrg`.
- **Decision:** The existing account `linked_org_ids` array remains an append-only candidate index. A trigger adds an org when a person-account link is inserted and a migration backfills existing links. The family reader starts from the authenticated global account, then checks active, verified links and active people separately inside `withOrg` for each candidate organization. Revocation does not remove the candidate ID.
- **Why:** Discovery stays fast while stale index entries never grant access. Every tenant read remains inside the org-scoped helper.
- **Consequences / follow-ups:** The family screen currently shows basic linked profiles. Profile/medical/document editing and athlete invitations remain Phase 2 work. Any new family consumer must recheck the link inside `withOrg`.

### DEC-080 — Keep global security-header policy in reusable middleware
- **Date:** 2026-09-27
- **Phase / area:** Phase 16 security headers
- **Context:** `server/src/app.ts` is owned by Track C, while Phase 16 security tests and policy are owned by Track SEC.
- **Decision:** Implement the strict, testable header policy as a new reusable middleware under `server/src/lib/security/`; Track C mounts it at the application boundary before API/static routes. Keep production-only HSTS conditional and give `/embed/*` an explicit framing exception.
- **Why:** Security behavior stays independently testable without crossing the app-wiring ownership boundary, and the app applies one header policy consistently.
- **Consequences / follow-ups:** Track C must mount the middleware and preserve its embedding exception before global header acceptance is complete.

### DEC-081 — Discover encryption-rotation tenants through the account index
- **Date:** 2026-09-27
- **Phase / area:** Phase 16 key rotation
- **Context:** Rotation must cover all known tenant ciphertext while every tenant row read or write remains under `withOrg`.
- **Decision:** Use `accounts.linked_org_ids` only to discover candidate organization IDs, then process every organization-owned ciphertext batch in its own `withOrg` transaction. Continue to process global MFA factor ciphertext in a normal transaction. Append a tenant audit event for each rewrapped tenant value and a global security event for each rewrapped MFA secret; record only the table/entity ID and key IDs.
- **Why:** The append-only account index supports cross-organization discovery without scanning protected organization rows outside the scoped helper; each candidate is still authorized by transaction-local tenant context and RLS. Audit evidence preserves the maintenance history without recording Restricted plaintext or ciphertext.
- **Consequences / follow-ups:** Any new organization-creation path must maintain the candidate index. Rotation defaults to a dry run; operators pass `--apply` only after validating the candidate keyring.

### DEC-097 — Require a staff-issued, email-bound adult profile claim
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 adult self links
- **Context:** An adult person may need to claim an existing profile, but a typed email search would let an account attach itself to another person's record.
- **Decision:** Staff issue a seven-day one-use invitation for an active adult person. A nonblank profile email must equal the invited email; a blank profile email is filled only at redemption. The token is bound to person, organization and email. Redemption requires an active, email-verified adult account, rechecks the current profile email against its issuance snapshot, rejects another person's use of that email, and allows only one active self link. The same global account may hold organization staff roles and a self person link.
- **Why:** Staff approval and email control authorize the exact profile attachment, while the redemption recheck closes the stale-record window. A shared account model lets an adult also serve as staff without creating a duplicate identity.
- **Consequences / follow-ups:** Email changes invalidate pending claims. Staff must issue a new invitation after a profile email change; existing verified links are handled through the account and person privacy flows.

### DEC-098 — Bind medical visibility to the exact child and active team
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 medical
- **Context:** Medical details are Restricted. A general People read permission must not expose them to registrars or team staff without the explicit organization setting and current relationship.
- **Decision:** Medical reads and writes recheck the active person inside `withOrg`. Verified guardians, adult self accounts, owners, admins and compliance officers receive full access; registrars receive it only when `registrarMedicalAccess` is true. A 13–17 self account receives a read-only full view. An active team staff member linked to the exact athlete through an active roster receives allergy flags by default, or full details when `coachMedicalAccess` is `full`; team staff cannot edit. Every permitted read writes a redacted audit entry, including an empty profile. Sensitive fields use AES-256-GCM encryption, and versioned writes serialize on the person row.
- **Why:** Authorization follows a current relationship and explicit setting, while a uniform 404 conceals records from other actors. Coaches get the safety flags they need without unnecessary detail.
- **Consequences / follow-ups:** Emergency contacts use a separate scope and authorization path. Family and staff medical editors consume the same versioned API.

### DEC-099 — Retain emergency contacts and protect the last active contact
- **Date:** 2026-09-27
- **Phase / area:** Phase 2 emergency contacts
- **Context:** The schema spine creates `emergency_contacts` at migration 0100, but the sprint reserves A's original migration range before that table exists. Existing contact rows have a unique priority that would prevent replacing a removed contact at the same priority.
- **Decision:** Migration 0900 adds `removed_at` and `version` after the spine and changes the priority constraint to apply only to active rows. Contacts are removed by timestamp, never deleted. The last active contact cannot be removed while a person has an active registration. Guardian, adult self, owner/admin/compliance and registrar editors may manage contacts; active team staff may read them. Minor self accounts may read but not edit. All permitted reads and writes are audited without copying phone numbers into audit changes.
- **Why:** Teams retain an emergency contact for active participants, concurrent edits cannot silently overwrite, and replacement does not erase the safety record.
- **Consequences / follow-ups:** 0900 is an unused post-spine migration slot outside the original A range because a pre-spine ALTER cannot apply. The emergency-contact API and editor are shared by staff and family screens.

### DEC-100 — Keep Phase 15 imports additive and tenant-scoped
- **Date:** 2026-09-27
- **Phase / area:** Phase 15 imports and onboarding
- **Context:** Track A owns the Phase 2 import tables and routes while Phase 15 adds additional import kinds and reversible processing. Preset privacy and financial rollback behavior were not specified for the extension.
- **Decision:** Store Phase 15 batches, rows, and mapping presets in separate tenant-scoped tables and mount them as additive adapters. Keep saved mapping presets within one organization. Historical payments use the external method and are never re-charged; rollback cancels external payments, voids only untouched paid invoices, revokes imported credentials, and retains financial evidence.
- **Why:** This avoids overwriting Track A's import engine, prevents cross-organization preset leakage, and preserves financial and compliance records.
- **Consequences / follow-ups:** Reconcile the additive route/job mount with Track A whenever trunk is merged. Volunteer-hours rows use the Phase 11 table contract and remain subject to H's final schema review.
### DEC-101 — Reverse imported operations with status changes
- **Date:** 2026-09-27
- **Phase / area:** Phase 15 imports
- **Context:** Normal tenant tables intentionally do not grant DELETE to the application role, and automatic review rejected a proposed migration that broadened this privilege. Operational records still need an import rollback path.
- **Decision:** Roll back records through the domain's inactive state when one exists: retire teams, withdraw team seasons and registrations, release roster entries, remove team staff, archive facilities/spaces, cancel schedules, and revoke credentials. Preserve relationship, participant, financial, file, compliance, audit and safety evidence; report records without a safe inactive state as retained.
- **Why:** This keeps rollback inside the existing withOrg/update permissions while preserving evidence needed for child safety and financial reconciliation.
- **Consequences / follow-ups:** Verify every importer kind has a supported reversal state before committing; retained records must be visible in the rollback summary for staff review.

### DEC-102 — Use the organization website URL for onboarding publication state
- **Date:** 2026-09-27
- **Phase / area:** Phase 15 onboarding
- **Context:** The current schema has `organizations.website_url`, but the website tables and publish state are being added by another track. The checklist must still detect persisted website setup without editing another track's migration range.
- **Decision:** Treat a non-empty organization website URL as completed website setup. When the website module adds an authoritative publication state, switch checklist detection to that state after reconciling the generated schema and routes from trunk.
- **Why:** This gives organizations a durable automatic completion signal using the field already exposed in the organization profile API.
- **Consequences / follow-ups:** Track D should confirm the canonical published-site state before final Phase 15 integration.
