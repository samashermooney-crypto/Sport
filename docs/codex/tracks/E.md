# Track E — Stripe and finance

Status: ready-for-integration
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/e-finance`
Current: Build spine-independent webhook dispatch, Connect onboarding UI and money orchestration; Phase 4 persistence follows the spine.
Ready for integration: local `cf83f4c..4e97356` — Stripe SDK dependency and test-mode gateway.
Requests to other tracks: A: mount `createStripeWebhookRouter` at `/api/v1/webhooks` before JSON parsing when Stripe repository/worker dependencies are wired (2026-09-26).
Blocked on: Phase 4 database persistence awaits schema spine and test factories on `rebuild/trunk`.
Gateway: Stripe SDK 22.6.2 dependency-only commit `cf83f4c`; real SDK adapter covers Connect, Customers, payment methods, intents, refunds, reversals, disputes, payouts, Billing and domains.
Gateway tests: 36 passed, including stripe-mock Express account and destination PaymentIntent; typecheck and targeted lint green.
Gateway review: test-only keys and events enforced; raw webhook bytes verified; exact destination fee and idempotency key asserted.
Gateway review: no live keys, no real payment or email sent; test-mode smoke script needs operator test credentials and onboarding.
Gateway gate: 83 tests, typecheck, lint, build, registry/OpenAPI/codegen freshness green; no gateway screens for Playwright.
Webhooks: platform/Connect raw-body routes, separate signatures, account scope check and atomic repository/dispatch contracts; 6 targeted HTTP/dispatch tests pass.
Payment webhooks: `finance/payment-events.ts` maps five PaymentIntent events to latest-state fetch and withOrg apply contract; stale/duplicate events and metadata guards have 2 targeted tests.
Money UI: Stripe React/JS dependency `73bdd07`; unmounted Connect onboarding and Payment Element components use token CSS, frozen quote lines and test-key guards; 4 component tests pass.
Money core: `finance/service.ts` uses Track B fee algorithms for service/application fees, validates frozen charges, enforces Connect/autopay gates and reserves idempotent PaymentIntent attempts; 8 targeted tests pass.
Money idempotency: PaymentIntent and refund attempts set a durable external-start fence before Stripe calls; ambiguous network/persistence failures remain blocked for reconciliation; 4 failure tests pass.
Connect core: `finance/connect.ts` defines withOrg reservation/persistence, org-stable Stripe account creation, onboarding/dashboard links and latest-state refresh; 5 targeted tests pass; unresolved Stripe creation keeps its reservation for reconciliation.
Checkout core: `checkout/service.ts` contracts for atomic holds, fixed lock order, processing/72-hour holds and automatic lost-capacity refunds; pure state machine and 8 targeted tests pass; real-Postgres oversell test awaits spine.
Checkout pricing: `checkout/pricing.ts` freezes Track B pricing from repository-owned inputs in one withOrg transaction, validates invoice/credit reconciliation and replays stored cents; 2 targeted tests pass.
Refund core: `finance/refunds.ts` applies Track B refund policy with proportional service-fee reversal, two-person threshold, ACH-processing block and stable idempotent Stripe refunds; 7 targeted tests pass.
Waitlist holds: `checkout/waitlist.ts` sets family-local send times and expiry from send, with one-transaction repository contract for capacity, offer and outbox; 2 targeted tests pass.
