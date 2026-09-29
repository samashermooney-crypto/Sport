# Athlentry

Athlentry is a multi-tenant sports organization management platform for youth and amateur leagues, clubs, academies, tournaments, and associations. It brings organization administration, family and athlete access, coach and official workflows, scheduling, registration, payments, communications, reporting, and public organization sites into one web product.

The rebuild is under active development. Features and screens depend on the account's organization, role, and configuration. The Render blueprint and Docker image are deployment references; they do not mean the production launch gate has passed. Legal pages remain marked as drafts until reviewed and approved by counsel.

## Product and architecture

- `web/` contains the React web app for organization staff, families, athletes, coaches, officials, and public pages.
- `server/` contains the Express API, jobs, authentication, and domain modules.
- `shared/` contains the versioned API schemas, sport templates, policies, and algorithms shared by the web and server.
- `db/migrations/` contains PostgreSQL migrations. Tenant data is accessed through organization-scoped helpers and PostgreSQL row-level security.
- Generated module and route registries connect feature modules to the app. The OpenAPI document is in `docs/api/openapi.json`.

Local authentication, payments, and outbound delivery use development/test adapters. Stripe must stay in test mode; email goes to Mailpit and SMS/push use preview or fake adapters. Do not use production credentials or send real messages from local development or tests.

## Local development

Requires Node.js 24 and Docker Compose. From the repository root:

```sh
npm ci
npm run dev
```

`npm run dev` starts the local PostgreSQL, Stripe mock, and Mailpit services, applies database migrations, and starts the API, worker, and web app. Open <http://127.0.0.1:5173>. The API health endpoint is <http://127.0.0.1:3001/healthz>.

To load demo data in the development database, run `npm run db:seed`. To stop the services, press Ctrl+C in the development process or run `npm run db:down`. See [Environment configuration](docs/ENVIRONMENT.md) for local ports, environment variables, secret handling, and production settings.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
npm run registry
npm run openapi
```

Playwright uses the local e2e database and test adapters. Follow the [testing guide](docs/codex/30-TESTING-AND-QUALITY.md) when running browser tests or changing generated files.

## Deployment reference

The [Dockerfile](Dockerfile) builds the application image and [render.yaml](render.yaml) describes the reference services. Production requires separately managed PostgreSQL credentials, encrypted backups, object storage, provider webhooks, verified sending domains, and legal approval. Read the [operations runbook](docs/ops/RUNBOOK.md), [custom-domain guide](docs/ops/CUSTOM-DOMAINS.md), and [environment guide](docs/ENVIRONMENT.md) before preparing a deployment. Production must keep `LEGAL_DOCS_APPROVED=false` until the required documents are approved.

## Not included

- Native mobile apps
- Livestream video
- Hotel or stay-to-play booking
- QuickBooks API sync (CSV export is in scope)
- Payroll
- SSO/SAML
- Third-party plugin marketplace
- Multi-currency support
- Non-US tax handling
- AI features beyond those specified in Phase 15

See [the product specification](docs/codex/00-START-HERE.md) and [current project status](docs/codex/PROGRESS.md) for scope, limitations, and acceptance evidence.
