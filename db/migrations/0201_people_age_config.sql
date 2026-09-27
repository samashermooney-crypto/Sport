UPDATE organizations
SET settings = settings || '{"peopleSchoolYearCutoff":"08-01"}'::jsonb
WHERE NOT settings ? 'peopleSchoolYearCutoff';
