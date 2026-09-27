ALTER TABLE website_pages
  DROP CONSTRAINT website_pages_slug_check,
  ADD CONSTRAINT website_pages_slug_check
    CHECK (
      slug ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'
      AND length(slug) <= 200
    );
