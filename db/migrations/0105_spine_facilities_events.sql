CREATE TABLE facilities (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  address jsonb,
  lat numeric(9,6),
  lng numeric(9,6),
  timezone text,
  ownership text NOT NULL CHECK (ownership IN ('owned', 'permitted', 'partner')),
  notes_html text,
  parking_notes text,
  map_url text,
  public boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  CHECK (lng IS NULL OR lng BETWEEN -180 AND 180)
);
CREATE INDEX facilities_org_public_idx ON facilities(org_id, public, name) WHERE archived_at IS NULL;
SELECT configure_spine_tenant_table('facilities');
ALTER TABLE programs ADD CONSTRAINT programs_default_facility_fk FOREIGN KEY (org_id, default_facility_id) REFERENCES facilities(org_id, id);
ALTER TABLE team_seasons ADD CONSTRAINT team_seasons_home_facility_fk FOREIGN KEY (org_id, home_facility_id) REFERENCES facilities(org_id, id);

CREATE TABLE spaces (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  facility_id uuid NOT NULL,
  parent_space_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('field', 'court', 'rink', 'pool', 'lanes', 'mat', 'diamond', 'track', 'room', 'other')),
  surface text,
  has_lights boolean NOT NULL DEFAULT false,
  suitability jsonb NOT NULL DEFAULT '{}'::jsonb,
  capacity_people integer CHECK (capacity_people IS NULL OR capacity_people >= 0),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, facility_id, id),
  CHECK (parent_space_id IS NULL OR parent_space_id <> id),
  FOREIGN KEY (org_id, facility_id) REFERENCES facilities(org_id, id),
  FOREIGN KEY (org_id, parent_space_id) REFERENCES spaces(org_id, id)
);
CREATE INDEX spaces_facility_idx ON spaces(org_id, facility_id, archived_at);
CREATE INDEX spaces_parent_idx ON spaces(org_id, parent_space_id) WHERE parent_space_id IS NOT NULL;
SELECT configure_spine_tenant_table('spaces');

CREATE TABLE space_availability (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  space_id uuid NOT NULL,
  rrule text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  source text NOT NULL CHECK (source IN ('owned', 'permit')),
  permit_reference text,
  cost_per_hour_cents bigint CHECK (cost_per_hour_cents IS NULL OR cost_per_hour_cents >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (starts_on <= ends_on),
  CHECK (start_time < end_time),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, id)
);
CREATE INDEX space_availability_space_idx ON space_availability(org_id, space_id, starts_on, ends_on);
SELECT configure_spine_tenant_table('space_availability');

CREATE TABLE space_blackouts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  space_id uuid,
  facility_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((space_id IS NOT NULL) <> (facility_id IS NOT NULL)),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, id),
  FOREIGN KEY (org_id, facility_id) REFERENCES facilities(org_id, id)
);
CREATE INDEX space_blackouts_space_idx ON space_blackouts(org_id, space_id, starts_at) WHERE space_id IS NOT NULL;
CREATE INDEX space_blackouts_facility_idx ON space_blackouts(org_id, facility_id, starts_at) WHERE facility_id IS NOT NULL;
SELECT configure_spine_tenant_table('space_blackouts');

CREATE TABLE allocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  space_id uuid NOT NULL,
  team_season_id uuid,
  division_id uuid,
  rrule text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('practice', 'games', 'clinic', 'other')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((team_season_id IS NOT NULL) <> (division_id IS NOT NULL)),
  CHECK (starts_on <= ends_on AND start_time < end_time),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id)
);
CREATE INDEX allocations_space_idx ON allocations(org_id, space_id, status, starts_on);
CREATE INDEX allocations_team_idx ON allocations(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX allocations_division_idx ON allocations(org_id, division_id) WHERE division_id IS NOT NULL;
SELECT configure_spine_tenant_table('allocations');

CREATE TABLE event_series (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  recurrence jsonb NOT NULL,
  start_time time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  timezone text NOT NULL,
  template jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX event_series_org_idx ON event_series(org_id, created_at DESC);
SELECT configure_spine_tenant_table('event_series');

CREATE TABLE schedule_generation_runs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  input jsonb NOT NULL,
  seed bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'applied', 'discarded')),
  result jsonb,
  created_by uuid NOT NULL REFERENCES accounts(id),
  applied_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);
CREATE INDEX schedule_generation_runs_program_idx ON schedule_generation_runs(org_id, program_id, status, created_at DESC);
SELECT configure_spine_tenant_table('schedule_generation_runs');

CREATE TABLE events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid,
  division_id uuid,
  kind text NOT NULL CHECK (kind IN ('game', 'practice', 'meet', 'match', 'bout_session', 'class_session', 'evaluation_session', 'tournament_game', 'meeting', 'volunteer_shift', 'other')),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  space_id uuid,
  location_text text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'postponed', 'canceled', 'completed')),
  status_reason text,
  published boolean NOT NULL DEFAULT false,
  series_id uuid,
  generation_run_id uuid,
  notes_html text,
  arrival_minutes_before integer NOT NULL DEFAULT 0 CHECK (arrival_minutes_before >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, id),
  FOREIGN KEY (org_id, series_id) REFERENCES event_series(org_id, id),
  FOREIGN KEY (org_id, generation_run_id) REFERENCES schedule_generation_runs(org_id, id)
);
CREATE INDEX events_org_time_idx ON events(org_id, starts_at, status);
CREATE INDEX events_program_idx ON events(org_id, program_id, starts_at) WHERE program_id IS NOT NULL;
CREATE INDEX events_division_idx ON events(org_id, division_id, starts_at) WHERE division_id IS NOT NULL;
CREATE INDEX events_space_idx ON events(org_id, space_id, starts_at) WHERE space_id IS NOT NULL;
CREATE INDEX events_series_idx ON events(org_id, series_id, starts_at) WHERE series_id IS NOT NULL;
CREATE INDEX events_generation_idx ON events(org_id, generation_run_id) WHERE generation_run_id IS NOT NULL;
SELECT configure_spine_tenant_table('events');

CREATE TABLE space_bookings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  booking_group_id uuid NOT NULL,
  leaf_space_id uuid NOT NULL,
  during tstzrange NOT NULL,
  event_id uuid,
  allocation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, booking_group_id, leaf_space_id),
  CHECK ((event_id IS NOT NULL) <> (allocation_id IS NOT NULL)),
  CHECK (NOT isempty(during)),
  FOREIGN KEY (org_id, leaf_space_id) REFERENCES spaces(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, allocation_id) REFERENCES allocations(org_id, id),
  EXCLUDE USING gist (leaf_space_id WITH =, during WITH &&)
);
CREATE INDEX space_bookings_event_idx ON space_bookings(org_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX space_bookings_allocation_idx ON space_bookings(org_id, allocation_id) WHERE allocation_id IS NOT NULL;
CREATE INDEX space_bookings_group_idx ON space_bookings(org_id, booking_group_id);
SELECT configure_spine_tenant_table('space_bookings');

CREATE FUNCTION reject_nonleaf_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM spaces WHERE org_id = NEW.org_id AND parent_space_id = NEW.leaf_space_id) THEN
    RAISE EXCEPTION 'A booking must claim leaf spaces';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_bookings_leaf_only BEFORE INSERT OR UPDATE OF leaf_space_id ON space_bookings
  FOR EACH ROW EXECUTE FUNCTION reject_nonleaf_booking();

CREATE FUNCTION reject_child_of_booked_space() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_space_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM space_bookings b
    WHERE b.org_id = NEW.org_id AND b.leaf_space_id = NEW.parent_space_id
      AND upper(b.during) > now()
  ) THEN
    RAISE EXCEPTION 'Move or cancel future bookings before splitting this space';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER spaces_reject_booked_split BEFORE INSERT OR UPDATE OF parent_space_id ON spaces
  FOR EACH ROW EXECUTE FUNCTION reject_child_of_booked_space();

CREATE TABLE closures (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  scope_type text NOT NULL CHECK (scope_type IN ('facility', 'space', 'org')),
  scope_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('weather', 'maintenance', 'permit', 'other')),
  message text,
  created_by uuid NOT NULL REFERENCES accounts(id),
  notified_at timestamptz,
  affected_event_ids uuid[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (starts_at < ends_at),
  CHECK ((scope_type = 'org' AND scope_id IS NULL) OR (scope_type <> 'org' AND scope_id IS NOT NULL))
);
CREATE INDEX closures_window_idx ON closures(org_id, starts_at, ends_at);
SELECT configure_spine_tenant_table('closures');

CREATE TABLE event_participants (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  team_season_id uuid,
  external_team_id uuid,
  person_id uuid,
  division_id uuid,
  side text NOT NULL DEFAULT 'none' CHECK (side IN ('home', 'away', 'none')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(team_season_id, external_team_id, person_id, division_id) = 1),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, external_team_id) REFERENCES external_teams(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id)
);
CREATE INDEX event_participants_event_idx ON event_participants(org_id, event_id);
CREATE INDEX event_participants_team_idx ON event_participants(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX event_participants_person_idx ON event_participants(org_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX event_participants_external_idx ON event_participants(org_id, external_team_id) WHERE external_team_id IS NOT NULL;
CREATE INDEX event_participants_division_idx ON event_participants(org_id, division_id) WHERE division_id IS NOT NULL;
SELECT configure_spine_tenant_table('event_participants');

CREATE TABLE reschedule_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES accounts(id),
  reason text NOT NULL,
  proposed_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined', 'withdrawn')),
  decided_by uuid REFERENCES accounts(id),
  resulting_event_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, resulting_event_id) REFERENCES events(org_id, id)
);
CREATE INDEX reschedule_requests_event_idx ON reschedule_requests(org_id, event_id, status);
CREATE INDEX reschedule_requests_result_idx ON reschedule_requests(org_id, resulting_event_id) WHERE resulting_event_id IS NOT NULL;
SELECT configure_spine_tenant_table('reschedule_requests');

CREATE TABLE calendar_feeds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid REFERENCES accounts(id),
  team_season_id uuid,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((account_id IS NOT NULL) <> (team_season_id IS NOT NULL)),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX calendar_feeds_account_idx ON calendar_feeds(org_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX calendar_feeds_team_idx ON calendar_feeds(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
SELECT configure_spine_tenant_table('calendar_feeds');
