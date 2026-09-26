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
