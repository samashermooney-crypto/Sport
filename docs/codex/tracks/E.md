# Track E — Stripe and finance

Status: ready-for-integration
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/e-finance`
Current: Build spine-independent webhook dispatch, Connect onboarding UI and money orchestration; Phase 4 persistence follows the spine.
Ready for integration: local `cf83f4c..4e97356` — Stripe SDK dependency and test-mode gateway.
Requests to other tracks: none
Blocked on: Phase 4 database persistence awaits schema spine and test factories on `rebuild/trunk`.
Gateway: Stripe SDK 22.6.2 dependency-only commit `cf83f4c`; real SDK adapter covers Connect, Customers, payment methods, intents, refunds, reversals, disputes, payouts, Billing and domains.
Gateway tests: 36 passed, including stripe-mock Express account and destination PaymentIntent; typecheck and targeted lint green.
Gateway review: test-only keys and events enforced; raw webhook bytes verified; exact destination fee and idempotency key asserted.
Gateway review: no live keys, no real payment or email sent; test-mode smoke script needs operator test credentials and onboarding.
Gateway gate: 83 tests, typecheck, lint, build, registry/OpenAPI/codegen freshness green; no gateway screens for Playwright.
