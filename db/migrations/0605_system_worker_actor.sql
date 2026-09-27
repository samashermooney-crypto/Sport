-- A locked, passwordless account supplies an attributable actor for tenant jobs.
INSERT INTO accounts
  (id, email, email_verified_at, first_name, last_name, date_of_birth, status)
VALUES
  ('0199a1c0-0000-7000-8000-000000000001',
   'jobs@system.athlentry.invalid', now(), 'System', 'Worker', '1900-01-01', 'locked')
ON CONFLICT (id) DO NOTHING;
