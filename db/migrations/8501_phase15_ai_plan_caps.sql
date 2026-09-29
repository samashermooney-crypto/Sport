UPDATE plans
SET limits = coalesce(limits, '{}'::jsonb) || jsonb_build_object(
  'aiEventsPerMonth',
  CASE key
    WHEN 'starter' THEN 100
    WHEN 'pro' THEN 1000
    WHEN 'enterprise' THEN 5000
    ELSE 100
  END
)
WHERE key IN ('starter', 'pro', 'enterprise');
