# Athlentry

Athlentry is an active rebuild of a multi-tenant sports organization platform for youth and amateur leagues, clubs, academies, tournament operators, parks departments, and governing associations. The web app brings organization staff, coaches, officials, volunteers, athletes, and families into one role-scoped workspace. Feature availability depends on the organization’s configuration and the user’s role; the rebuild is still in progress.

The platform is designed around organization-scoped PostgreSQL data and a versioned HTTP API. The server uses TypeScript, Express, and Kysely; the web app uses React, React Router, and the preserved Athlentry design system. Background work runs through a separate worker and PostgreSQL-backed job queue. Migrations, shared schemas and policies, API documentation, and generated route registries live alongside the application code. The `legacy/` directory is a read-only visual and behavior reference while migration work is underway.

## Local development

Requires Node.js 24, npm, and Docker. From the repository root:

```sh
npm ci
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://127.0.0.1:5173>. The API health check is <http://127.0.0.1:3001/healthz>. Local and automated environments use the Stripe mock and preview messaging adapters; never configure live payment, email, SMS, or push credentials for local development. See [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) for variables and safety boundaries. Stop Compose services with `npm run db:down`.

## Common commands

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
npm run registry
npm run openapi
```

End-to-end tests use Playwright and require the local test services and browser dependencies. The CI workflow is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Architecture and operations

- Product requirements, decisions, and phase acceptance: [`docs/codex/00-START-HERE.md`](docs/codex/00-START-HERE.md) and [`docs/codex/`](docs/codex/).
- API contract: [`docs/api/openapi.json`](docs/api/openapi.json).
- Deployment reference: [`Dockerfile`](Dockerfile) and [`render.yaml`](render.yaml).
- Environment setup: [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).
- Operations and incident procedures: [`docs/ops/RUNBOOK.md`](docs/ops/RUNBOOK.md) and [`docs/codex/40-OPERATOR-CHECKLIST.md`](docs/codex/40-OPERATOR-CHECKLIST.md).
- Public organization-site domains: [`docs/ops/CUSTOM-DOMAINS.md`](docs/ops/CUSTOM-DOMAINS.md).
- Security design and reporting: [`docs/security/`](docs/security/).

Deployment files are reference configuration. A production operator must provision and verify the external database, object storage, domain, payment account, delivery providers, monitoring, backups, and keys. Production start requires approved legal documents; the marketing legal pages remain watermarked drafts until `LEGAL_DOCS_APPROVED=true`.

## Not included

Native mobile apps, livestream video, hotel or stay-to-play booking, QuickBooks API sync (CSV accounting export is in scope), payroll, SSO/SAML, a third-party plugin marketplace, multi-currency, non-US tax handling, and AI features beyond the explicitly scoped form drafting, message translation, and public-content help assistant are outside the project scope. See decision D18 in [`docs/codex/00-START-HERE.md`](docs/codex/00-START-HERE.md).
