# Athlentry

Athlentry is being rebuilt as a multi-tenant sports management platform. The current branch is Phase 0: repository and tooling setup. The web page is a sign-in skeleton and account access is not implemented yet. The previous prototype is preserved in `legacy/` as reference code. The specification and live checklist are in [`docs/codex/`](docs/codex/00-START-HERE.md) and [`PROGRESS.md`](docs/codex/PROGRESS.md).

## Local development

Requires Node 24 and Docker. Run:

```sh
npm ci
npm run db:up
npm run dev
```

Open <http://127.0.0.1:5173>. `GET http://127.0.0.1:3001/healthz` returns `{"status":"ok"}`. `npm run db:down` stops the Compose services. See [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) for configuration and safety boundaries.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

## Not included

Native mobile apps, livestream video, hotel booking, QuickBooks API sync, payroll, SSO/SAML, third-party plugin marketplace, multi-currency, and non-US tax handling are outside this project. CSV accounting export is planned. The full scope is in `docs/codex/00-START-HERE.md`.
