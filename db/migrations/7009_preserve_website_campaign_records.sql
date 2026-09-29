-- Phase 14's initial website schema included public-display records for
-- sponsors and fundraising. Phase 11 owns the canonical operational tables
-- with these names, so keep the original rows and tenant protections under
-- explicit legacy names before its migration creates the canonical tables.
ALTER TABLE sponsors RENAME TO website_legacy_sponsors;
ALTER TABLE fundraising_campaigns RENAME TO website_legacy_fundraising_campaigns;
ALTER TABLE donations RENAME TO website_legacy_donations;
