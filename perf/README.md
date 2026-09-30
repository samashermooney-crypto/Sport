# Load-test scenarios

These k6 scenarios target an isolated preview deployment with synthetic accounts and the preview/fake provider adapters. Never commit fixture JSON, bearer tokens, child/family data, provider credentials or output that contains request data. Put fixtures in an ignored local directory and remove them after a run.

## Safety and run shape

Each script requires `K6_TARGET_ENV=isolated-preview`, a non-production runner `NODE_ENV`, and `DELIVERY_MODE=preview`. `STRIPE_SECRET_KEY`, when present, must not begin with `sk_live_`. Set `BASE_URL` to the isolated preview API origin. Use ten offerings with limited capacity for registration-open, a load-seeded database for all four scenarios, and the reference deployment sizing in `docs/codex/13-PHASE-PRODUCTION.md §2`.

For this worktree's local stack, start services with `COMPOSE_PROJECT_NAME=athlentry_ops PORT_OFFSET=1400 npm run db:up`; the API origin is `http://127.0.0.1:4401` when started by `npm run dev` with the same environment. Local runs exercise one web process and are useful for fixture checks; they do not count as reference-deployment acceptance results.

Example shared environment:

```sh
export K6_TARGET_ENV=isolated-preview
export NODE_ENV=test
export DELIVERY_MODE=preview
export BASE_URL=http://127.0.0.1:4401
```

Set the scenario-specific fixture variables to private JSON files generated from disposable preview accounts and the route contracts. For example, `REGISTRATION_OPEN_PATH` is the exact path E supplies; do not guess or substitute a production URL. Run each scenario with k6 and save a summary JSON under `perf/results/`:

```sh
REGISTRATION_FAMILIES_FILE="$FIXTURE_DIR/registration.json" REGISTRATION_OPEN_PATH="$REGISTRATION_OPEN_PATH" k6 run --summary-export=perf/results/registration-open-summary.json perf/registration-open.js
READ_REQUESTS_FILE="$FIXTURE_DIR/reads.json" k6 run --summary-export=perf/results/steady-reads-summary.json perf/steady-reads.js
COACH_FIXTURES_FILE="$FIXTURE_DIR/coaches.json" PUBLIC_READS_FILE="$FIXTURE_DIR/public-reads.json" k6 run --summary-export=perf/results/game-day-summary.json perf/game-day.js
CAMPAIGN_FIXTURE_FILE="$FIXTURE_DIR/campaign.json" k6 run --summary-export=perf/results/campaign-fanout-summary.json perf/campaign-fanout.js
```

The JSON summary contains aggregate metrics only. Review thresholds and dropped iterations; do not commit raw k6 logs or fixture data.

## Scenario inputs and acceptance

| Script                 | Fixture inputs                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Required acceptance                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registration-open.js` | `REGISTRATION_FAMILIES_FILE`: `{ "families": [2000 synthetic family sessions], "offerings": [{ "id": "...", "capacity": 1 }] }`, with unique UUID idempotency keys and exactly 10 offering IDs. Each configured capacity must be positive and lower than its attempted family count. `REGISTRATION_OPEN_PATH`: the stable family registration/checkout start route supplied by Track E.                                                                             | 2,000 requests begin over 10 minutes, no unexpected responses or dropped iterations, and the post-run capacity-counter query from Track E proves no offering was oversold. Expected 409 capacity outcomes are recorded separately. |
| `steady-reads.js`      | `READ_REQUESTS_FILE`: authenticated GET records `{ surface: "console" or "portal", path, token }`, covering both surfaces.                                                                                                                                                                                                                                                                                                                                          | Constant 200 requests/second for 10 minutes, zero unexpected responses/dropped iterations, p95 under 300 ms and p99 under 1 second.                                                                                                |
| `game-day.js`          | `COACH_FIXTURES_FILE`: 500 synthetic coaches with separate attendance/score bodies, paths, bearer tokens and unique UUID idempotency keys; `attendanceMethod` (default `POST`) selects the attendance verb, `PATCH` for `/api/v1/attendance/orgs/{orgId}/events/{eventId}/people/{personId}/attendance`. `PUBLIC_READS_FILE`: public schedule and standings GET paths.                                                                                                                                                                                                                                                            | 500 concurrent coaches submit attendance and scores; public reads run at 5,000 requests/minute for 10 minutes; zero unexpected responses/dropped iterations and p95 under 500 ms.                                                  |
| `campaign-fanout.js`   | `CAMPAIGN_FIXTURE_FILE`: one synthetic, email-only campaign with exactly 20,000 eligible recipients and preview/fake delivery. Use `POST /api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/send` with the expected version and confirmed preview count; poll `GET /api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/stats`. The durable completed and failed paths are `counts.email.sent` and `counts.email.failed`; campaign state is `status`. | No unexpected responses or failed recipients; durable completed-recipient count reaches 20,000 within 900 seconds.                                                                                                                 |

Run the registration capacity query immediately after k6, against the same isolated database and the ten offering IDs in the local fixture. Store only the ten aggregate capacity/held/registered values in the result note. Query plans and recommended indexes belong in `perf/query-review.md`; load-profile plans must use the documented 100-org profile.

For campaign fan-out, create the campaign draft and preview it before the run. Set `enqueuePath` to the campaign `/send` route and `enqueueBody` to its current `expectedVersion` plus `confirmRecipientCounts` copied from the preview; for an email-only audience of 20,000, the confirmed count must be `{ "email": 20000 }`. Set `statusPath` to the campaign `/stats` route, `completedFieldPath` to `counts.email.sent`, `failedFieldPath` to `counts.email.failed`, and `statusFieldPath` to `status`. The send request handles an initial bounded batch, and the `communications.deliver-due` worker drains remaining deliveries while k6 polls the durable stats.
