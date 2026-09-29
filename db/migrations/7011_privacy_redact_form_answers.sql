-- Form responses are append-only for ordinary application writes. A verified
-- privacy deletion may redact answer payloads while keeping the response record
-- and its timestamps for the audit trail.
-- The definer function runs as the migration owner, so these narrowly scoped
-- policies let it see only the subject tenant while FORCE RLS remains enabled.
CREATE POLICY privacy_redact_registration_scope ON public.registrations
  TO PUBLIC
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE POLICY privacy_redact_form_response_scope ON public.form_responses
  TO PUBLIC
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE FUNCTION privacy_redact_person_form_responses(
  target_org_id uuid,
  target_person_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed integer;
BEGIN
  IF target_org_id IS NULL OR target_person_id IS NULL OR
     target_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'privacy redaction must run inside the subject organization'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.form_responses AS response
  SET answers = '{}'::jsonb,
      answers_enc = NULL
  WHERE response.org_id = target_org_id
    AND (
      (response.subject_type = 'person' AND response.subject_id = target_person_id)
      OR (
        response.subject_type = 'registration'
        AND response.subject_id IN (
          SELECT registration.id
          FROM public.registrations AS registration
          WHERE registration.org_id = target_org_id
            AND registration.person_id = target_person_id
        )
      )
    )
    AND (response.answers <> '{}'::jsonb OR response.answers_enc IS NOT NULL);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION privacy_redact_person_form_responses(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_redact_person_form_responses(uuid, uuid) TO athlentry_app;

CREATE FUNCTION privacy_purge_expired_auth_tokens(token_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  purged integer;
BEGIN
  IF token_cutoff IS NULL OR token_cutoff > statement_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION 'auth tokens can only be purged 30 days after expiry'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.auth_tokens WHERE expires_at < token_cutoff;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION privacy_purge_expired_auth_tokens(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_purge_expired_auth_tokens(timestamptz) TO athlentry_app;
