# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Trunk and A–E worktrees ready; `PORT_OFFSET` infrastructure passes offset browser/API smoke tests, with preview SMTP handoff pending.
Ready for integration: none
Requests to other tracks: C — make `createMailpitEmailSender` use `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025) so offset Playwright email journeys use their own Mailpit container.
Blocked on: none
