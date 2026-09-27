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

### DEC-082 — Preserve only representable legacy recurrence rules
- **Date:** 2026-09-26
- **Phase / area:** Phase 8 recurrence migration
- **Context:** The existing spine uses RFC recurrence text in availability and allocation rows; binding clarification C1 supports structured one-time, weekly and monthly-nth-weekday rules only.
- **Decision:** Convert the supported weekly and monthly-nth-weekday forms to structured JSON. Abort the migration with the offending rule when a stored rule cannot be represented, instead of guessing a cadence or silently dropping exceptions.
- **Why:** An incorrect availability window can create unsafe or impossible bookings; migration failure keeps source data intact for an explicit repair.
- **Consequences / follow-ups:** Verify the isolated database has only representable rules before applying migration 3000.

### DEC-083 — Treat non-space schedule conflicts as reasoned overrides
- **Date:** 2026-09-26
- **Phase / area:** Phase 8 conflict policy
- **Context:** The event specification permits override reasons for soft conflicts and explicitly says space double-booking is never overridable, but does not classify team, coach and official overlap severity.
- **Decision:** Require an override reason for team, coach and official overlaps; never override a space booking, closure, blackout or availability violation.
- **Why:** The database remains the final protection against unsafe venue double-booking, while staff retain a documented path to resolve calendar edge cases.
- **Consequences / follow-ups:** Every override is written to the audit log and exposed in the conflict report.

### DEC-084 — Preserve materialized schedule history during series edits
- **Date:** 2026-09-26
- **Phase / area:** Phase 8 recurring events
- **Context:** The series edit scopes must update future materialized events while preserving references from contests, attendance, audit and results.
- **Decision:** Keep past and completed event rows unchanged. Update matching future occurrences in place, cancel obsolete future rows with a reason, and mark a detached one-time series inactive so its horizon job cannot recreate the event.
- **Why:** Event identity carries operational history; hard deletion or rewriting completed occurrences would orphan that history.
- **Consequences / follow-ups:** Migration 3006 adds `event_series.active`; generated recurrence extension skips inactive series.

### DEC-085 — Store coach schedule blackout requests as approved date ranges
- **Date:** 2026-09-26
- **Phase / area:** Phase 8 schedule generator
- **Context:** The shared generator accepts team blackout dates, but the inherited spine has no request table or approval workflow for those dates.
- **Decision:** Add tenant-scoped date-range requests per team season. Coaches can request them; a scheduler approval is required before the generator treats them as hard constraints.
- **Why:** This preserves a clear approval boundary and avoids silently making a coach preference a hard scheduling rule.
- **Consequences / follow-ups:** Migration 3007 adds the request aggregate and indexed status; generator input includes approved request dates.

### DEC-086 — Snapshot sport profiles with a database trigger
- **Date:** 2026-09-26
- **Phase / area:** Phase 9 result format history
- **Context:** Contests must use the exact sport profile format version they were created against, but the inherited spine has no append-only profile version table.
- **Decision:** Backfill version 1, append a snapshot whenever `sport_profiles.profile` changes, and reference the snapshot from each contest. Snapshot rows reject update and delete.
- **Why:** Historical result validation and rendering must remain tied to the format configuration used at contest creation.
- **Consequences / follow-ups:** Migration 3008 adds the version table, snapshot trigger, and contest foreign key; sport-profile editing continues to use the current profile row.

### DEC-087 — Snapshot sport profiles after the source row is written
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 result format history
- **Context:** The insert trigger added with DEC-084 attempted to insert its version row before the referenced sport profile existed, violating the composite tenant foreign key during profile creation.
- **Decision:** Set the next profile version in a `BEFORE UPDATE` trigger, then append the immutable version snapshot in an `AFTER INSERT OR UPDATE` trigger.
- **Why:** The source profile must exist at the referenced version before the snapshot row is inserted; this preserves the composite foreign key and append-only history.
- **Consequences / follow-ups:** Migration 3013 repairs trigger timing without rewriting migration 3008; verify factory profile creation and profile edits in the database test suite.

### DEC-088 — Keep survey responses anonymous in staff summaries
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 season end
- **Context:** Family feedback needs a simple NPS and free text, while the response table must prevent duplicate submissions per account.
- **Decision:** Require a verified guardian/self link to a confirmed program registration, store the respondent account only for deduplication, and omit account/person identity from manager summaries. Survey language is selected per campaign (`en` or `es`).
- **Why:** The organization can prevent duplicate voting and restrict results to scoped staff while keeping feedback content unattributed.
- **Consequences / follow-ups:** A staff member with program schedule management permission can read comments; schedule batches now create in-app records through Track B's notification service, while email fan-out remains Phase 10 work.

### DEC-089 — Use the browser print dialog for season award PDFs
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 season end
- **Context:** The owned web feature needs printable award certificates, but no PDF-generation service exists in Track G's paths.
- **Decision:** Render escaped certificate content in a print-only browser document and let staff save it as PDF through the native print dialog.
- **Why:** This creates a usable PDF path without adding a generator dependency or persisting an unsafe user-uploaded file.
- **Consequences / follow-ups:** Certificates are local browser output, not a server-rendered or stored artifact; connect to the files/PDF service if a reusable downloadable certificate is required.

### DEC-090 — Seed pool elimination rounds from finalized standings
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 pool tournaments
- **Context:** Pool tournaments need a deterministic transition from round-robin results to elimination play, while late corrections must not silently invalidate already-started playoff matches.
- **Decision:** Once every pool contest is final, calculate standings with the program's sport-specific shared rules and seed the bracket with the shared cross-pool algorithm by default. `config.poolSeeding: "overall"` selects overall points-per-game ranking. After elimination matches exist, pool result corrections are rejected.
- **Why:** Tournament progression must use the same standings and bracket rules as other sport operations, and the seeded playoff must stay stable once it begins.
- **Consequences / follow-ups:** Pool standings must have enough results to satisfy sport-specific tiebreakers. Bracket foreign-key links are attached only after all round rows exist.

### DEC-091 — Assign timed meet lanes as a versioned contest operation
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 individual-sport meets
- **Context:** Contest participants already have seed, heat, and lane fields, but timed meets had no scoped operation for assigning them before results were entered.
- **Decision:** Require a complete assignment for each timed meet participant, enforce unique seeds and heat/lane cells within the sport's lane limit, and increment the contest version with the assignment.
- **Why:** Meet lanes and seeds affect the official result workflow and need the same tenant, permission, and stale-write protections as scores.
- **Consequences / follow-ups:** Timed meet assignments close before final results; other multi-event format scheduling can reuse this aggregate operation if the sport rules require it.

### DEC-092 — Return only public tournament display fields
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 public tournament pages
- **Context:** Tournament brackets are readable by slug without an authenticated organization context, while the internal bracket record also contains tenant, program, and configuration identifiers.
- **Decision:** The public bracket endpoint returns only the bracket title, type, size, status, public team display names, seeds, match positions, contest links, and matchup slots.
- **Why:** Visitors need match information, while internal configuration and aggregate metadata do not help them follow a tournament.
- **Consequences / follow-ups:** Add any additional public-facing tournament content through an explicit allowlisted response shape.

### DEC-093 — Persist tournament schedule reservations separately from bracket matches
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 tournament scheduling
- **Context:** Pool games can be scheduled before their match rows are played, while elimination match rows for pool tournaments are not created until final pool standings are known.
- **Decision:** Persist each scheduled pool game and reserved bracket slot in a tenant-scoped reservation table; attach bracket match IDs when they are available and retain event IDs for the full schedule history.
- **Why:** The shared tournament generator can reserve real space and time before the bracket is seeded without inventing placeholder bracket rows or losing schedule-to-match links.
- **Consequences / follow-ups:** Tournament event creation and match binding must run transactionally, and bracket views must expose reservation times only through the authorized tournament response.

### DEC-094 — Keep resource-calendar moves in the schedule feature
- **Date:** 2026-09-27
- **Phase / area:** Phase 8 resource calendar
- **Context:** The shared calendar renders read-only resource slots, while the schedule acceptance requires event moves by drag-and-drop and an equivalent keyboard path. Track G cannot change Track D’s owned design-system components.
- **Decision:** Compose a schedule-owned resource calendar from existing UI controls. Both move paths use the versioned event update endpoint, preserve elapsed duration, interpret the target slot in the destination facility timezone, and pass optional reason text for server-approved soft-conflict overrides. Event and recurrence create/edit forms expose the same reason field; hard conflicts remain unoverridable.
- **Why:** The scheduling feature needs its operational move workflow while retaining the frozen shared design system and backend as the authority for booking conflicts.
- **Consequences / follow-ups:** The calendar remains inside `web/src/console/schedule`; Track A must mount the feature and add the cross-browser schedule journeys.

### DEC-095 — Generate schedule, results and standings PDFs through browser print
- **Date:** 2026-09-27
- **Phase / area:** Phases 8–9 schedule and sport exports
- **Context:** Schedule and meet results require CSV/PDF exports, standings and tournament brackets must print, and Track G has no server-side PDF service in its owned modules.
- **Decision:** Build printable documents from permission-scoped schedule, contest and standings responses and let the browser print dialog save them as PDF. CSV exports use permission-scoped data and escape fields against spreadsheet formulas.
- **Why:** Staff need usable paper/PDF output without storing duplicate operational data or adding an unrelated PDF dependency.
- **Consequences / follow-ups:** PDFs are generated in the browser and are not stored as organization files; reusable downloadable artifacts can move to the Files/PDF service if that becomes a requirement.

### DEC-096 — Serialize standings snapshot arrays as JSON
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 standings snapshots
- **Context:** PostgreSQL's driver encodes JavaScript arrays as PostgreSQL arrays by default, while the standings snapshot column is `jsonb`.
- **Decision:** Serialize the computed standings row array to JSON text before inserting it into the snapshot column.
- **Why:** Every refresh must persist the same rows returned to the standings reader instead of failing at the database boundary.
- **Consequences / follow-ups:** The isolated PostgreSQL integration test covers snapshot creation, labels and visibility reads.

### DEC-097 — Keep private athlete statistics out of personal-best views
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 athlete statistics
- **Context:** Personal-best records are shown in the family portal, and a single endpoint serves both athlete/guardian links and staff roles.
- **Decision:** Return only athlete-level statistics marked public in the sport profile; staff-only team statistics remain behind their existing scoped endpoint.
- **Why:** One predictable response keeps private youth performance data out of family-facing personal-best summaries.
- **Consequences / follow-ups:** Sport profile definitions must mark a statistic public before it appears in family personal-best views.

### DEC-098 — Commit lineup suspension audits before returning a conflict
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 discipline enforcement
- **Context:** The discipline policy writes an audit row when it blocks a suspended athlete, but throwing the HTTP conflict from inside the `withOrg` transaction rolls that audit row back.
- **Decision:** Return a suspension-blocked result from the transaction callback, commit the audit entry, then raise the scheduling conflict after `withOrg` completes.
- **Why:** A denied lineup must remain denied while preserving the required safety audit trail.
- **Consequences / follow-ups:** The attendance integration test verifies the athlete is not added and the audit record persists. Automatic result-to-discipline record creation remains dependent on Track F's missing service method.

### DEC-099 — Attribute meet team points through active program rosters
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 individual/hybrid sport results
- **Context:** `contest_participants` accepts exactly one of person, team or external entrant, so a swimmer entered as a person had no team attached and place points could never roll up to team scores.
- **Decision:** When computing ranked results and contest team scores, resolve each person entrant's team from the earliest active/injured/suspended `roster_entries` row on a `team_seasons` row in the event's program (and division when the event has one).
- **Why:** Team scoring is a required meet outcome and roster membership is the authoritative athlete-to-team link for the season.
- **Consequences / follow-ups:** `listContestResults` returns per-contest `teamScores`; athletes rostered on multiple teams in one program/division attach to the earliest roster entry.

### DEC-100 — Align contest stage values to the data-model enum
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 contests and tournaments
- **Context:** The contest API and `createContest` accepted `tournament` as a stage while `02-DATA-MODEL.md` and the `contests_stage_check` constraint allow only `regular|pool|playoff|championship|consolation|friendly|exhibition`; seeded bracket matches therefore failed to persist.
- **Decision:** Constrain the service input and route enum to the data-model values and persist seeded non-pool bracket matches as `playoff`.
- **Why:** The specification enum and database constraint are authoritative; inserting an invalid stage broke every bracket-linked contest creation.
- **Consequences / follow-ups:** Track B's shared `contestStageSchema` still exposes `tournament` and omits `championship`/`consolation`/`exhibition`; standings `include.stages` should be aligned to the data-model enum by its owner.

### DEC-101 — Declined and no-show assignments release the crew position
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 officials assignment
- **Context:** The position-occupancy check and `official_assignments_active_position_idx` treated every non-canceled assignment as occupying the slot, so a declined offer permanently blocked reassignment.
- **Decision:** Only `offered`, `accepted` and `confirmed` assignments occupy a contest position; migration 3017 narrows the partial unique index to those live statuses.
- **Why:** The Phase 9 acceptance path requires declining an offer and reassigning a replacement to the same position.
- **Consequences / follow-ups:** Declined and no-show assignments remain as history rows but no longer reserve the position.

### DEC-102 — Standings recompute must not block result finalization
- **Date:** 2026-09-27
- **Phase / area:** Phase 9 standings recompute
- **Context:** `submitContestResult` recomputes standings inside the finalization transaction, but 14 seeded sport templates carry no `defaultStandings` and most programs never configure standings, so `computeSnapshot` threw "Standings rules have not been configured" and rolled back every finalized result for those sports. A second defect in the same path: `contest_results.score` returns as a string (numeric column), and `computeStandings` rejected it with `Invalid contest score`.
- **Decision:** `recomputeStandingsForEvent` now skips scopes without an explicit or profile-default standings config, while `getStandings`/`refreshStandings` keep returning the 409 "not configured" response. Standings score inputs are normalized from numeric strings to numbers before computation.
- **Why:** Result finalization is a required operation for every sport; standings only apply where configured. The numeric-string normalization matches the existing guard used for tournament scores.
- **Consequences / follow-ups:** Covered by the new recompute test (finalization, correction, forfeit, stale-version conflict) and the per-sport format validation test over all 46 seeded templates.
