# Track E — Stripe and finance

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/e-finance`
Current: Schema spine merged; Phase 4 persistence in progress, starting with durable Stripe event ingress.
Ready for integration: local `cf83f4c..4e97356` — Stripe SDK dependency and test-mode gateway.
Additional ready for integration: local `4e97356..c7dd637` — spine-independent webhook, Connect, payment UI and money orchestration contracts.
Requests to other tracks: A: mount `createStripeWebhookRouter` at `/api/v1/webhooks` before JSON parsing when Stripe repository/worker dependencies are wired; regenerate DB types after E migrations 1000–1003 merge (2026-09-26).
Requests to other tracks: B: confirm whether `generateInstallments` must support `weekly` from `02 §L` (current `20 §3` algorithm and shared function cover fixed dates/monthly only) (2026-09-26).
Blocked on: None; schema spine and test factories are on `rebuild/trunk`.
Next: wire PaymentIntent webhook handlers to scoped payment/invoice/checkout writes, then implement saved-method sync, installment dunning, credits and reconciliation on the spine.
Gateway: Stripe SDK 22.6.2 dependency-only commit `cf83f4c`; real SDK adapter covers Connect, Customers, payment methods, intents, refunds, reversals, disputes, payouts, Billing and domains.
Gateway tests: 36 passed, including stripe-mock Express account and destination PaymentIntent; typecheck and targeted lint green.
Gateway review: test-only keys and events enforced; raw webhook bytes verified; exact destination fee and idempotency key asserted.
Gateway review: no live keys, no real payment or email sent; test-mode smoke script needs operator test credentials and onboarding.
Gateway gate: 83 tests, typecheck, lint, build, registry/OpenAPI/codegen freshness green; no gateway screens for Playwright.
Additional gate: 267 tests passed/1 skipped against isolated Postgres, typecheck, lint and build green; no affected mounted Playwright screens or generated inputs.
Additional review: `20 §3–§5` fee, installment and state rules checked; every external Stripe money call now has a durable claim before invocation.
Additional review: webhook handlers fetch latest Stripe state and require org-scoped id/amount matching; repository persistence and real concurrency gates await spine.
Additional review: UI remains unmounted until API wiring, uses existing design tokens and test-only publishable keys; no live Stripe keys or messages used.
Webhooks: platform/Connect raw-body routes, separate signatures, account scope check and atomic repository/dispatch contracts; 6 targeted HTTP/dispatch tests pass.
Payment webhooks: `finance/payment-events.ts` maps five PaymentIntent events to latest-state fetch and withOrg apply contract; stale/duplicate events and metadata guards have 2 targeted tests.
Webhook persistence: migration 1000 adds lease token/expiry; `stripe/repo.ts` atomically dedupes, claims, retries and fences stale workers on real Postgres; 4 targeted repository tests pass.
Money UI: Stripe React/JS dependency `73bdd07`; unmounted Connect onboarding and Payment Element components use token CSS, frozen quote lines and test-key guards; 4 component tests pass.
Money core: `finance/service.ts` uses Track B fee algorithms for service/application fees, validates frozen charges, enforces Connect/autopay gates and reserves idempotent PaymentIntent attempts; 8 targeted tests pass.
Money idempotency: PaymentIntent and refund attempts set a durable external-start fence before Stripe calls; ambiguous network/persistence failures remain blocked for reconciliation; 4 failure tests pass.
Payment attempts: migration 1002 and `finance/attempt-repo.ts` persist scoped request-hash conflicts, pre-external retries, external fences and replayed results; 3 real-Postgres tests pass.
Installment quotes: `finance/installment-quotes.ts` uses Track B schedule and fee algorithms to show per-charge service/application fees and reconcile the plan total; 2 targeted tests pass.
Connect core: `finance/connect.ts` defines withOrg reservation/persistence, org-stable Stripe account creation, onboarding/dashboard links and latest-state refresh; 5 targeted tests pass; unresolved Stripe creation keeps its reservation for reconciliation.
Connect persistence: `finance/repo.ts` implements a durable one-row reservation, idempotent account sync and cross-org RLS isolation on spine `payment_accounts`; 2 real-Postgres tests pass.
Payer methods: `finance/payer-methods.ts` lazily creates one platform Customer with a durable reservation, creates off-session SetupIntents and lists account-attached methods; 4 targeted tests pass.
Payer persistence: migration 1001 permits a durable incomplete `payer_profiles` row; `finance/payer-repo.ts` fences duplicate Customer creation and stores one customer ID; 2 real-Postgres tests pass.
Checkout core: `checkout/service.ts` contracts for atomic holds, fixed lock order, processing/72-hour holds and automatic lost-capacity refunds; pure state machine and 9 targeted tests pass; real-Postgres oversell test awaits spine.
Lost-capacity refunds: checkout now durably claims each intent before Stripe refund and preserves uncertain claims for reconciliation; 1 replay/failure test added.
Checkout pricing: `checkout/pricing.ts` freezes Track B pricing from repository-owned inputs in one withOrg transaction, validates invoice/credit reconciliation and replays stored cents; 2 targeted tests pass.
Refund core: `finance/refunds.ts` applies Track B refund policy with proportional service-fee reversal, two-person threshold, ACH-processing block and stable idempotent Stripe refunds; 7 targeted tests pass.
Refund attempts: migration 1003 and `finance/refund-attempt-repo.ts` persist scoped request-hash conflicts, pre-external retries, external fences and exact replay results; 2 real-Postgres tests pass.
Invoice issuance: migration 1004 adds product-tax lines and creation keys; `finance/invoice-repo.ts` atomically numbers, dedupes and reconciles header/lines with the spine triggers; 2 real-Postgres tests pass.
Waitlist holds: `checkout/waitlist.ts` sets family-local send times and expiry from send, with one-transaction repository contract for capacity, offer and outbox; 2 targeted tests pass.
