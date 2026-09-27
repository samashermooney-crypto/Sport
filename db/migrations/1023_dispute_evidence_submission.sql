ALTER TABLE disputes
  ADD COLUMN evidence_submission_state text NOT NULL DEFAULT 'none'
    CHECK (evidence_submission_state IN ('none', 'reserved', 'external_started', 'completed')),
  ADD COLUMN evidence_submission_key uuid,
  ADD COLUMN evidence_packet_hash text,
  ADD COLUMN evidence_packet jsonb,
  ADD COLUMN evidence_response_status text,
  ADD CONSTRAINT disputes_evidence_submission_shape CHECK (
    (evidence_submission_state = 'none' AND evidence_submission_key IS NULL
      AND evidence_packet_hash IS NULL AND evidence_packet IS NULL)
    OR
    (evidence_submission_state <> 'none' AND evidence_submission_key IS NOT NULL
      AND evidence_packet_hash IS NOT NULL AND evidence_packet IS NOT NULL
      AND jsonb_typeof(evidence_packet) = 'object')
  );
