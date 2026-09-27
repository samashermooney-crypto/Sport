ALTER TABLE aid_applications
  ADD COLUMN award_bps integer CHECK (award_bps BETWEEN 1 AND 10000),
  ADD COLUMN award_operation_key uuid,
  ADD COLUMN award_request_hash text;

CREATE UNIQUE INDEX aid_applications_award_operation_idx
  ON aid_applications(org_id, award_operation_key)
  WHERE award_operation_key IS NOT NULL;

ALTER TABLE aid_applications
  ADD CONSTRAINT aid_award_terms_check CHECK (
    award_kind <> 'fixed' OR award_bps IS NULL
  );
