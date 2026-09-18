# Backend initialization and configuration

How to create a real (non-demo) organization and configure the backend.
Requires Node.js 22.13+.

## Clean initialization

```sh
npm run init -- \
  --db data/fieldhouse.sqlite \
  --org-name "River City Athletics" \
  --timezone America/Chicago \
  --owner-name "Jordan Owner" \
  --owner-email "owner@example.com"
```

`server/initialize.mjs` creates exactly one organization and one `owner`
console user — no people, programs, invoices or other demo fixtures.

- `--db` selects the database file (default: `DATABASE_PATH`, else
  `data/fieldhouse.sqlite`). The schema is created if the file is new.
- `--org-id` sets the organization id used in member site URLs
  (`/site/:org/...`). Default: the org name slugified
  (`River City Athletics` → `river-city-athletics`).
- Any missing value is prompted for on a TTY. Non-interactive runs require all
  flags.

### Owner password

The password is **never** taken from a flag — it is read from a hidden prompt
(typed twice), or from `FIELDHOUSE_OWNER_PASSWORD` for non-interactive use:

```sh
FIELDHOUSE_OWNER_PASSWORD="$(read -rs -p 'Password: ' p; echo "$p")" npm run init -- ...
```

Passwords are never printed or logged. Policy: 12–128 characters, the same as
console password change/reset.

### Validation and refusal

- Organization name (1–150 chars), time zone (must be a valid IANA zone),
  owner name/email and password are all validated; failures exit `1` and roll
  back — a partial organization is never left behind.
- If the database already contains an organization or console user,
  initialization refuses with exit code `2` and changes nothing. This protects
  both live data and the demo database.
- Currency is fixed `USD`; do not advertise conversion.

### What initialization does NOT do

It does not seed demo records and does not start the server. After it succeeds,
start the API (`npm run dev` / `npm start`) and sign in as the owner at the
console login. Account email delivery must be configured (below) before the
owner can invite more console users in production — in development the
invitation endpoints return labeled preview links instead.

## Demo seeding stays separate

Demo fixtures only run from `server/index.mjs` on an empty database, and only
when `shouldSeedDemo` allows it:

- `NODE_ENV=production` → seeding is skipped unless `SEED_DEMO=true` is set
  explicitly.
- `SEED_DEMO=false` disables seeding in any environment.

The fictional demo administrator (`admin@fieldhouse.local`) therefore can never
appear in production by accident; `DEMO_PASSWORD` still changes its password
when seeding is intentionally run.

## Environment reference

| Variable | Purpose |
|---|---|
| `DATABASE_PATH` | Database file (default `data/fieldhouse.sqlite`) |
| `PORT`, `HOST` | API bind (default `127.0.0.1:3001`) |
| `COOKIE_SECURE` | `true` adds `Secure` to session cookies — set behind HTTPS |
| `PUBLIC_URL` | Public HTTPS origin used in emailed links; required for live auth delivery |
| `AUTH_EMAIL_DELIVERY_ENABLED` | `true` switches invitation/recovery email from dev preview to live |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend credentials for account email |
| `SEED_DEMO` | `true`/`false` overrides demo seeding |
| `DEMO_PASSWORD` | Demo owner password when seeding a new database |
| `FIELDHOUSE_OWNER_PASSWORD` | Non-interactive owner password for `npm run init` |

When `AUTH_EMAIL_DELIVERY_ENABLED` is unset in development, invitation and
recovery endpoints return a `development_link` field for local UI testing. In
production the same requests answer `503` until delivery is configured — no
invitation row is persisted in that case, and no development link is ever
returned.

## Verification

Covered by `server/initialize.test.mjs`: clean init + owner login, repeated-run
refusal, rollback on invalid input, refusal on a seeded demo database (which
keeps working), and migration of a legacy `users` table.
