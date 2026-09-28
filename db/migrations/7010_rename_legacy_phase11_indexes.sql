-- 7008 added FK indexes for these three Phase 11-owned tables before their
-- canonical migration was available. Preserve the indexes on the legacy
-- website data while freeing the canonical names for Phase 11's equivalents.
ALTER INDEX fundraising_campaigns_team_season_fk_idx
  RENAME TO website_legacy_campaigns_team_season_fk_idx;
ALTER INDEX sponsors_invoice_fk_idx
  RENAME TO website_legacy_sponsors_invoice_fk_idx;
ALTER INDEX donations_donor_account_fk_idx
  RENAME TO website_legacy_donations_donor_account_fk_idx;
ALTER INDEX donations_payment_fk_idx
  RENAME TO website_legacy_donations_payment_fk_idx;
