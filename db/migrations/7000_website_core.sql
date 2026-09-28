-- Phase 14: public website surface (pages, revisions, menus, news, contact,
-- domains, embeds). All tenant tables go through configure_spine_tenant_table.

CREATE TABLE website_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  social jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_inbox_email citext,
  home_page_id uuid,
  robots_policy text NOT NULL DEFAULT 'index' CHECK (robots_policy IN ('index', 'noindex')),
  published boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT configure_spine_tenant_table('website_settings');

CREATE TABLE website_pages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-/]*$' AND length(slug) <= 200),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  kind text NOT NULL DEFAULT 'content' CHECK (kind IN ('content', 'auto')),
  auto_key text CHECK (auto_key IS NULL OR auto_key ~ '^[a-z][a-z0-9_:-]*$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id),
  UNIQUE (org_id, auto_key)
);
CREATE INDEX website_pages_published_idx ON website_pages(org_id, slug) WHERE status = 'published';
SELECT configure_spine_tenant_table('website_pages');

ALTER TABLE website_settings
  ADD CONSTRAINT website_settings_home_page_fk
  FOREIGN KEY (org_id, home_page_id) REFERENCES website_pages(org_id, id);

CREATE TABLE website_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  page_id uuid NOT NULL,
  title text NOT NULL,
  blocks jsonb NOT NULL,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, page_id) REFERENCES website_pages(org_id, id)
);
CREATE INDEX website_revisions_page_idx ON website_revisions(org_id, page_id, created_at DESC);
SELECT configure_spine_tenant_table('website_revisions', true);

CREATE TABLE website_menus (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  location text NOT NULL CHECK (location IN ('header', 'footer')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, location),
  UNIQUE (org_id, id)
);
SELECT configure_spine_tenant_table('website_menus');

CREATE TABLE news_posts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$' AND length(slug) <= 200),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  excerpt text,
  body_html text NOT NULL DEFAULT '',
  cover_file_id uuid,
  author_account_id uuid REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id)
);
CREATE INDEX news_posts_published_idx ON news_posts(org_id, published_at DESC) WHERE status = 'published';
SELECT configure_spine_tenant_table('news_posts');

-- Contact form submissions are write-only from the public site; staff read them
-- in the console. The turnstile_token column records proof a bot check ran.
CREATE TABLE contact_submissions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  email citext NOT NULL,
  subject text,
  body text NOT NULL CHECK (length(trim(body)) > 0),
  turnstile_token text,
  ip inet,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX contact_submissions_unread_idx ON contact_submissions(org_id, created_at DESC) WHERE status = 'new';
SELECT configure_spine_tenant_table('contact_submissions');

CREATE TABLE site_domains (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  host citext NOT NULL UNIQUE CHECK (host ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('subdomain', 'custom')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verifying', 'active', 'failed', 'disabled')),
  verify_token text NOT NULL,
  verification_method text NOT NULL DEFAULT 'cname' CHECK (verification_method IN ('cname', 'txt')),
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  last_checked_at timestamptz,
  check_detail text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX site_domains_one_primary_idx ON site_domains(org_id) WHERE is_primary;
SELECT configure_spine_tenant_table('site_domains');

CREATE TABLE embed_widgets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('program_list', 'schedule', 'standings', 'registration_button')),
  public_key text NOT NULL UNIQUE,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
SELECT configure_spine_tenant_table('embed_widgets');

-- Sponsors and fundraising campaigns feed the auto-generated public pages.
-- Phase 11 builds management/invoicing on top of these tables.
CREATE TABLE sponsors (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_file_id uuid,
  website_url text,
  tier text NOT NULL DEFAULT 'standard',
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  contract_start date,
  contract_end date,
  placements jsonb NOT NULL DEFAULT '[]'::jsonb,
  invoice_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX sponsors_active_idx ON sponsors(org_id, tier) WHERE status = 'active';
SELECT configure_spine_tenant_table('sponsors');

CREATE TABLE fundraising_campaigns (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$' AND length(slug) <= 200),
  goal_cents integer CHECK (goal_cents IS NULL OR goal_cents >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  team_season_id uuid,
  description_html text NOT NULL DEFAULT '',
  image_file_id uuid,
  show_donor_names boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX fundraising_campaigns_public_idx ON fundraising_campaigns(org_id, slug) WHERE status = 'active';
SELECT configure_spine_tenant_table('fundraising_campaigns');

CREATE TABLE donations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  campaign_id uuid NOT NULL,
  donor_account_id uuid REFERENCES accounts(id),
  donor_name text,
  donor_email citext,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  anonymous boolean NOT NULL DEFAULT false,
  dedication text,
  payment_id uuid,
  receipt_number text,
  receipt_sent_at timestamptz,
  quid_pro_quo_value_cents integer NOT NULL DEFAULT 0 CHECK (quid_pro_quo_value_cents >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, campaign_id) REFERENCES fundraising_campaigns(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id)
);
CREATE INDEX donations_campaign_idx ON donations(org_id, campaign_id, created_at DESC);
SELECT configure_spine_tenant_table('donations');
