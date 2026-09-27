# Officials module activation

The generated files are inactive templates. Specialize the schema and migration,
then rename each `.template` file to its active extension. The registry will then
discover `module.ts`, `routes.tsx`, and `nav.ts`.

Before activation:

1. Add all tenant columns, composite foreign keys, RLS policies, grants, retention
   behavior, and indexes required by the data model. Confirm the migration number
   is still free on the integration branch.
2. Implement the repository through `withOrg`, with no raw tenant queries.
3. Wire the service, permission checks, audit, and versioned API routes using the
   module contract. Return 404 for foreign organization IDs.
4. Replace every test scaffold with real Postgres assertions for cross-tenant
   isolation, permission denial, and restricted-read audit where applicable.
5. Connect list, detail, and form screens to the API client and Track D UI
   primitives. Render only working controls. Verify keyboard and screen reader use.
6. Run `npm run registry`, `npm run openapi`, the full phase gate, and review the
   generated API schema. Delete this guide when the module is complete.
