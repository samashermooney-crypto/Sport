# Team registration parity requirements

Verified from public LeagueApps documentation, September 7, 2026. Supplements native Safari evidence; does not prove current account configuration.

[Registration Options Guide](https://support.leagueapps.com/hc/en-us/articles/360039863793-Registration-Options-Guide):

- Team completion can require roster thresholds, half/full payment, both, or neither. Incomplete teams do not consume program team capacity.
- Direct team signup offers a team selector. Captain approval can precede completion.
- Youth team creation belongs to program staff; adult teams are created through captain registration.
- Capacity counting can include pending players or reserved players only.

[Program Pricing Options](https://support.leagueapps.com/hc/en-us/articles/360039865613-Program-Pricing-Options-and-Configurations): team charges may be fixed or per-player, assigned entirely to captain/staff or shared among players. These are separate settings.

[Manual team creation](https://support.leagueapps.com/hc/en-us/articles/360039383054-How-to-manually-create-teams): manual invoicing permits joining without an automatic charge; variable pricing invoices members during signup.

[Team Manager](https://support.leagueapps.com/hc/en-us/articles/360043603854-Team-Manager): bulk copies have additional restrictions and invoice/form workflows. Do not equate the local individual metadata-copy action with that feature.

## Current implementation gaps, from local code

`server/program-rules.mjs` has player capacity counting and captain flags, but no team completion criteria, team capacity, or fixed/shared fee model. `createTeam` creates admin records only. Member signup supports individuals/staff; team creation, direct join, invitation acceptance, and captain approval remain absent. Existing team copy carries metadata without invoices/rosters. Existing roster movement preserves invoices; pricing-dependent recalculation is not implemented.

## Implementation dependencies

1. Model team pricing responsibility and completion criteria explicitly; retain migration defaults for existing admin-created teams.
2. Implement a derived team registration status from applicable rules, roster and team-linked invoice state. Test rule changes, membership changes, payments/refunds, and no-constraint teams.
3. Enforce program team capacity at applicable registration transitions using the complete-team count. Keep player capacity independently enforced.
4. Add member team creation and direct joining with existing identity, forms, waivers, eligibility and invoice transactions; keep captain authority separate from parent visibility.
5. Add invitation/approval lifecycle and price-aware transfers, then source-specific UI/state audit.

Unresolved: exact current source labels/options, custom team overrides, pricing migrations, completion transition policy when capacity is already full, manual administrative bypasses, and source team-message composition. Do not call these requirements complete based on current team CRUD tests.
