-- Keep foreign-key lookups indexed as the spine grows. Existing leading-prefix
-- indexes are reused; a missing FK gets a deterministic, narrowly scoped index.
DO $$
DECLARE
  link record;
  columns_sql text;
  index_name text;
BEGIN
  FOR link IN
    SELECT c.oid, c.conrelid, c.conname, c.conkey
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = link.conrelid AND i.indisvalid AND i.indisready
        AND ARRAY(
          SELECT value FROM unnest(
            (string_to_array(i.indkey::text, ' '))[1:array_length(link.conkey, 1)]
          ) AS value ORDER BY value
        ) = ARRAY(
          SELECT value::text FROM unnest(link.conkey) AS value ORDER BY value::text
        )
    ) THEN
      SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY key_columns.ordinality)
        INTO columns_sql
      FROM unnest(link.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = link.conrelid AND attribute.attnum = key_columns.attnum;
      index_name := 'spine_fk_' || substr(md5(link.conrelid::text || ':' || link.conname), 1, 20);
      EXECUTE format('CREATE INDEX %I ON %s (%s)', index_name, link.conrelid::regclass, columns_sql);
    END IF;
  END LOOP;
END;
$$;
