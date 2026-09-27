ALTER TABLE season_survey_campaigns
  ADD COLUMN locale text NOT NULL DEFAULT 'en'
    CHECK (locale IN ('en', 'es'));
