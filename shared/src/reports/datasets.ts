// Curated dataset catalog for the report builder (Phase 14). Every column is
// a whitelist entry: the query builder only ever emits these names, so report
// definitions can never reach unauthorized tables or Restricted fields the
// actor cannot see. Tier gates follow 04 §2.

export type DataTier = 'public' | 'internal' | 'sensitive' | 'restricted';

export type ColumnType =
  'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'enum';

export interface DatasetColumn {
  /** Stable key used in report definitions and CSV headers. */
  key: string;
  label: string;
  type: ColumnType;
  tier: DataTier;
  /** Table alias + column, resolved against the dataset's join map. */
  source: string;
  /** Optional per-column enum labels for display. */
  values?: readonly string[];
}

export interface DatasetJoin {
  alias: string;
  table: string;
  /** ON clause expressed with aliases only, e.g. "p.id = r.person_id". */
  on: string;
  kind?: 'inner' | 'left';
}

export interface Dataset {
  key: string;
  label: string;
  description: string;
  /** Base table alias is always `t`. */
  table: string;
  /** Other tables the dataset must touch; absence makes it unavailable. */
  requiredTables: readonly string[];
  joins: readonly DatasetJoin[];
  /** Org roles allowed to query this dataset at all. */
  roles: readonly string[];
  columns: readonly DatasetColumn[];
}

const col = (
  key: string,
  label: string,
  type: ColumnType,
  tier: DataTier,
  source?: string,
): DatasetColumn => ({ key, label, type, tier, source: source ?? `t.${key}` });

const STAFF = [
  'owner',
  'admin',
  'registrar',
  'finance',
  'scheduler',
  'compliance',
  'communications',
  'director',
  'volunteer_coordinator',
  'reporter',
] as const;

const MONEY_ROLES = ['owner', 'admin', 'finance', 'reporter'] as const;
const SAFETY_ROLES = ['owner', 'admin', 'compliance', 'reporter'] as const;

export const REPORT_DATASETS: readonly Dataset[] = [
  {
    key: 'people',
    label: 'People',
    description: 'Member directory records',
    table: 'people',
    requiredTables: ['people', 'medical_profiles'],
    joins: [
      {
        alias: 'm',
        table: 'medical_profiles',
        on: 'm.person_id = t.id AND m.org_id = t.org_id',
        kind: 'left',
      },
    ],
    roles: STAFF,
    columns: [
      col('id', 'Person ID', 'text', 'internal'),
      col('first_name', 'First name', 'text', 'internal'),
      col('last_name', 'Last name', 'text', 'internal'),
      col('preferred_name', 'Preferred name', 'text', 'internal'),
      col('date_of_birth', 'Birthdate', 'date', 'sensitive'),
      col('gender', 'Gender', 'text', 'sensitive'),
      col('competition_gender', 'Competition gender', 'text', 'internal'),
      col('email', 'Email', 'text', 'sensitive'),
      col('phone_e164', 'Phone', 'text', 'sensitive'),
      col('address', 'Address', 'text', 'sensitive'),
      col('graduation_year', 'Graduation year', 'number', 'internal'),
      col('school_name', 'School', 'text', 'sensitive'),
      col(
        'media_consent',
        'Media consent',
        'enum',
        'internal',
        't.media_consent',
      ),
      col('status', 'Status', 'enum', 'internal'),
      col('created_at', 'Created', 'datetime', 'internal'),
      col(
        'allergy_flags',
        'Allergy flags',
        'text',
        'restricted',
        'm.allergy_flags',
      ),
    ],
  },
  {
    key: 'households',
    label: 'Households',
    description: 'Family units and membership',
    table: 'households',
    requiredTables: ['households'],
    joins: [],
    roles: STAFF,
    columns: [
      col('id', 'Household ID', 'text', 'internal'),
      col('name', 'Household name', 'text', 'internal'),
      col('address', 'Address', 'text', 'sensitive'),
      col('status', 'Status', 'enum', 'internal'),
      col('created_at', 'Created', 'datetime', 'internal'),
    ],
  },
  {
    key: 'registrations',
    label: 'Registrations',
    description: 'Program registrations with participant and program context',
    table: 'registrations',
    requiredTables: [
      'registrations',
      'people',
      'programs',
      'divisions',
      'households',
    ],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'h',
        table: 'households',
        on: 'h.id = t.household_id AND h.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'pr',
        table: 'programs',
        on: 'pr.id = t.program_id AND pr.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'd',
        table: 'divisions',
        on: 'd.id = t.division_id AND d.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'o',
        table: 'registration_offerings',
        on: 'o.id = t.offering_id AND o.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'ts',
        table: 'team_seasons',
        on: 'ts.id = t.team_season_id AND ts.org_id = t.org_id',
        kind: 'left',
      },
    ],
    roles: STAFF,
    columns: [
      col('id', 'Registration ID', 'text', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('source', 'Source', 'enum', 'internal'),
      col('created_at', 'Registered at', 'datetime', 'internal'),
      col('canceled_at', 'Canceled at', 'datetime', 'internal'),
      col(
        'person_name',
        'Participant',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col(
        'person_birthdate',
        'Participant birthdate',
        'date',
        'sensitive',
        'p.date_of_birth',
      ),
      col(
        'person_gender',
        'Participant gender',
        'enum',
        'sensitive',
        'p.gender',
      ),
      col('person_email', 'Participant email', 'text', 'sensitive', 'p.email'),
      col(
        'household_postal_code',
        'Household ZIP/postal code',
        'text',
        'sensitive',
        "h.address ->> 'postalCode'",
      ),
      col('program_name', 'Program', 'text', 'internal', 'pr.name'),
      col('division_name', 'Division', 'text', 'internal', 'd.name'),
      col('age_label', 'Age group', 'text', 'internal', 'd.age_label'),
      col('offering_name', 'Offering', 'text', 'internal', 'o.name'),
      col('team_name', 'Team', 'text', 'internal', 'ts.display_name'),
    ],
  },
  {
    key: 'rosters',
    label: 'Rosters',
    description: 'Team roster entries',
    table: 'roster_entries',
    requiredTables: ['roster_entries', 'people', 'team_seasons', 'teams'],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
      {
        alias: 'ts',
        table: 'team_seasons',
        on: 'ts.id = t.team_season_id AND ts.org_id = t.org_id',
      },
      {
        alias: 'tm',
        table: 'teams',
        on: 'tm.id = ts.team_id AND tm.org_id = t.org_id',
      },
      {
        alias: 'd',
        table: 'divisions',
        on: 'd.id = ts.division_id AND d.org_id = t.org_id',
        kind: 'left',
      },
    ],
    roles: STAFF,
    columns: [
      col('id', 'Entry ID', 'text', 'internal'),
      col(
        'person_name',
        'Athlete',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col(
        'person_birthdate',
        'Birthdate',
        'date',
        'sensitive',
        'p.date_of_birth',
      ),
      col('team_name', 'Team', 'text', 'internal', 'ts.display_name'),
      col('division_name', 'Division', 'text', 'internal', 'd.name'),
      col('jersey_number', 'Jersey', 'text', 'internal'),
      col('positions', 'Positions', 'text', 'internal'),
      col('joined_on', 'Joined', 'date', 'internal'),
      col('left_on', 'Left', 'date', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
    ],
  },
  {
    key: 'invoices',
    label: 'Invoices',
    description: 'Invoice headers with balances',
    table: 'invoices',
    requiredTables: ['invoices', 'households'],
    joins: [
      {
        alias: 'h',
        table: 'households',
        on: 'h.id = t.household_id AND h.org_id = t.org_id',
        kind: 'left',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Invoice ID', 'text', 'internal'),
      col('number', 'Number', 'text', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('household_name', 'Household', 'text', 'internal', 'h.name'),
      col('total_cents', 'Total', 'money', 'sensitive'),
      col('paid_cents', 'Paid', 'money', 'sensitive'),
      col('balance_cents', 'Balance', 'money', 'sensitive'),
      col('discount_cents', 'Discounts', 'money', 'sensitive'),
      col('refunded_cents', 'Refunded', 'money', 'sensitive'),
      col('due_on', 'Due date', 'date', 'internal'),
      col('issued_at', 'Issued', 'datetime', 'internal'),
      col('created_at', 'Created', 'datetime', 'internal'),
    ],
  },
  {
    key: 'invoice_lines',
    label: 'Invoice lines',
    description: 'Line items with GL codes',
    table: 'invoice_lines',
    requiredTables: ['invoice_lines', 'invoices', 'people'],
    joins: [
      {
        alias: 'i',
        table: 'invoices',
        on: 'i.id = t.invoice_id AND i.org_id = t.org_id',
      },
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'pr',
        table: 'programs',
        on: 'pr.id = t.program_id AND pr.org_id = t.org_id',
        kind: 'left',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Line ID', 'text', 'internal'),
      col('invoice_number', 'Invoice', 'text', 'internal', 'i.number'),
      col('description', 'Description', 'text', 'internal'),
      col('kind', 'Kind', 'enum', 'internal'),
      col('gl_code', 'GL code', 'text', 'internal'),
      col('amount_cents', 'Amount', 'money', 'sensitive'),
      col('quantity', 'Quantity', 'number', 'internal'),
      col(
        'person_name',
        'Person',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col('program_name', 'Program', 'text', 'internal', 'pr.name'),
      col('created_at', 'Created', 'datetime', 'internal'),
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    description: 'Received payments and fees',
    table: 'payments',
    requiredTables: ['payments'],
    joins: [],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Payment ID', 'text', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('method', 'Method', 'enum', 'internal'),
      col('amount_cents', 'Amount', 'money', 'sensitive'),
      col('net_cents', 'Net', 'money', 'sensitive'),
      col('processing_fee_cents', 'Processing fee', 'money', 'sensitive'),
      col('application_fee_cents', 'Platform fee', 'money', 'sensitive'),
      col('receipt_number', 'Receipt', 'text', 'internal'),
      col('reference', 'Reference', 'text', 'internal'),
      col('succeeded_at', 'Succeeded at', 'datetime', 'internal'),
      col('created_at', 'Created', 'datetime', 'internal'),
    ],
  },
  {
    key: 'refunds',
    label: 'Refunds',
    description: 'Refund decisions and outcomes',
    table: 'refunds',
    requiredTables: ['refunds', 'payments'],
    joins: [
      {
        alias: 'p',
        table: 'payments',
        on: 'p.id = t.payment_id AND p.org_id = t.org_id',
        kind: 'left',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Refund ID', 'text', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('amount_cents', 'Amount', 'money', 'sensitive'),
      col('reason', 'Reason', 'text', 'internal'),
      col('destination', 'Destination', 'enum', 'internal'),
      col(
        'payment_reference',
        'Payment reference',
        'text',
        'internal',
        'p.reference',
      ),
      col('succeeded_at', 'Succeeded at', 'datetime', 'internal'),
      col('created_at', 'Created', 'datetime', 'internal'),
    ],
  },
  {
    key: 'installments',
    label: 'Installments',
    description: 'Payment plan installments',
    table: 'installments',
    requiredTables: ['installments', 'invoices'],
    joins: [
      {
        alias: 'i',
        table: 'invoices',
        on: 'i.id = t.invoice_id AND i.org_id = t.org_id',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Installment ID', 'text', 'internal'),
      col('invoice_number', 'Invoice', 'text', 'internal', 'i.number'),
      col('sequence', 'Sequence', 'number', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('amount_cents', 'Amount', 'money', 'sensitive'),
      col('paid_cents', 'Paid', 'money', 'sensitive'),
      col('due_on', 'Due date', 'date', 'internal'),
      col('autopay', 'Autopay', 'boolean', 'internal'),
      col('attempt_count', 'Attempts', 'number', 'internal'),
      col('next_attempt_at', 'Next attempt', 'datetime', 'internal'),
    ],
  },
  {
    key: 'attendance',
    label: 'Attendance',
    description: 'Event check-in and RSVP records',
    table: 'attendance',
    requiredTables: ['attendance', 'people', 'events'],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
      {
        alias: 'e',
        table: 'events',
        on: 'e.id = t.event_id AND e.org_id = t.org_id',
      },
    ],
    roles: STAFF,
    columns: [
      col('id', 'Record ID', 'text', 'internal'),
      col(
        'person_name',
        'Person',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col('event_title', 'Event', 'text', 'internal', 'e.title'),
      col(
        'event_starts_at',
        'Event start',
        'datetime',
        'internal',
        'e.starts_at',
      ),
      col('status', 'Status', 'enum', 'internal'),
      col('rsvp', 'RSVP', 'enum', 'internal'),
      col('checked_in_at', 'Checked in', 'datetime', 'internal'),
      col('checked_out_at', 'Checked out', 'datetime', 'internal'),
    ],
  },
  {
    key: 'credentials',
    label: 'Credentials',
    description: 'Staff credential status (documents stay in files)',
    table: 'person_credentials',
    requiredTables: ['person_credentials', 'people', 'credential_types'],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
      {
        alias: 'ct',
        table: 'credential_types',
        on: 'ct.id = t.credential_type_id AND ct.org_id = t.org_id',
      },
    ],
    roles: SAFETY_ROLES,
    columns: [
      col('id', 'Credential ID', 'text', 'internal'),
      col(
        'person_name',
        'Person',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col('credential_type', 'Type', 'text', 'internal', 'ct.name'),
      col('status', 'Status', 'enum', 'internal'),
      col('issued_on', 'Issued', 'date', 'internal'),
      col('expires_on', 'Expires', 'date', 'internal'),
      col('verified_at', 'Verified', 'datetime', 'internal'),
    ],
  },
  {
    key: 'background_checks',
    label: 'Background checks',
    description: 'Order status only — details never leave the safety module',
    table: 'background_check_orders',
    requiredTables: ['background_check_orders', 'people'],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
    ],
    roles: SAFETY_ROLES,
    columns: [
      col('id', 'Order ID', 'text', 'internal'),
      col(
        'person_name',
        'Person',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col('provider', 'Provider', 'enum', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('completed_at', 'Completed', 'datetime', 'internal'),
      col('created_at', 'Ordered', 'datetime', 'internal'),
    ],
  },
  {
    key: 'events',
    label: 'Events',
    description: 'Calendar events and results context',
    table: 'events',
    requiredTables: ['events'],
    joins: [
      {
        alias: 'pr',
        table: 'programs',
        on: 'pr.id = t.program_id AND pr.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 'd',
        table: 'divisions',
        on: 'd.id = t.division_id AND d.org_id = t.org_id',
        kind: 'left',
      },
      {
        alias: 's',
        table: 'spaces',
        on: 's.id = t.space_id',
        kind: 'left',
      },
      {
        alias: 'f',
        table: 'facilities',
        on: 'f.id = s.facility_id',
        kind: 'left',
      },
    ],
    roles: STAFF,
    columns: [
      col('id', 'Event ID', 'text', 'internal'),
      col('title', 'Title', 'text', 'internal'),
      col('kind', 'Kind', 'enum', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('starts_at', 'Starts', 'datetime', 'internal'),
      col('ends_at', 'Ends', 'datetime', 'internal'),
      col('published', 'Published', 'boolean', 'internal'),
      col('program_name', 'Program', 'text', 'internal', 'pr.name'),
      col('division_name', 'Division', 'text', 'internal', 'd.name'),
      col('space_name', 'Space', 'text', 'internal', 's.name'),
      col('facility_name', 'Facility', 'text', 'internal', 'f.name'),
      col('location_text', 'Location', 'text', 'internal'),
    ],
  },
  {
    key: 'officials_pay',
    label: 'Officials pay',
    description: 'Officials fee lines',
    table: 'official_pay_lines',
    requiredTables: ['official_pay_lines', 'people'],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Line ID', 'text', 'internal'),
      col(
        'person_name',
        'Official',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col('fee_cents', 'Fee', 'money', 'sensitive'),
      col('mileage_cents', 'Mileage', 'money', 'sensitive'),
      col('total_cents', 'Total', 'money', 'sensitive'),
      col('created_at', 'Created', 'datetime', 'internal'),
    ],
  },
  {
    key: 'donations',
    label: 'Donations',
    description: 'Fundraising donations',
    table: 'donations',
    requiredTables: ['donations', 'fundraising_campaigns'],
    joins: [
      {
        alias: 'c',
        table: 'fundraising_campaigns',
        on: 'c.id = t.campaign_id AND c.org_id = t.org_id',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Donation ID', 'text', 'internal'),
      col('campaign_name', 'Campaign', 'text', 'internal', 'c.name'),
      col('status', 'Payment status', 'enum', 'internal'),
      col('donor_name', 'Donor', 'text', 'sensitive'),
      col('amount_cents', 'Amount', 'money', 'sensitive'),
      col('anonymous', 'Anonymous', 'boolean', 'internal'),
      col('receipt_number', 'Receipt', 'text', 'internal'),
      col('created_at', 'Given at', 'datetime', 'internal'),
    ],
  },
  {
    key: 'aid_awards',
    label: 'Financial aid awards',
    description: 'Award totals by financial aid program',
    table: 'aid_applications',
    requiredTables: ['aid_applications', 'financial_aid_programs'],
    joins: [
      {
        alias: 'ap',
        table: 'financial_aid_programs',
        on: 'ap.id = t.financial_aid_program_id AND ap.org_id = t.org_id',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Application ID', 'text', 'internal'),
      col('program_name', 'Aid program', 'text', 'internal', 'ap.name'),
      col('status', 'Decision', 'enum', 'internal'),
      col('award_cents', 'Awarded', 'money', 'sensitive'),
      col('requested_cents', 'Requested', 'money', 'sensitive'),
      col('created_at', 'Applied', 'datetime', 'internal'),
    ],
  },
  {
    key: 'uniform_sizes',
    label: 'Uniform sizes',
    description: 'Paid uniform quantities by product size',
    table: 'store_order_lines',
    requiredTables: [
      'store_order_lines',
      'store_orders',
      'products',
      'product_variants',
    ],
    joins: [
      {
        alias: 'o',
        table: 'store_orders',
        on: 'o.id = t.order_id AND o.org_id = t.org_id',
      },
      {
        alias: 'p',
        table: 'products',
        on: 'p.id = t.product_id AND p.org_id = t.org_id',
      },
      {
        alias: 'v',
        table: 'product_variants',
        on: 'v.id = t.product_variant_id AND v.org_id = t.org_id',
      },
    ],
    roles: MONEY_ROLES,
    columns: [
      col('id', 'Order line ID', 'text', 'internal'),
      col('product_name', 'Product', 'text', 'internal', 'p.name'),
      col('product_kind', 'Product type', 'enum', 'internal', 'p.kind'),
      col('size', 'Size', 'text', 'internal', 'v.size'),
      col('color', 'Color', 'text', 'internal', 'v.color'),
      col('quantity', 'Quantity', 'number', 'internal'),
      col('order_status', 'Order status', 'enum', 'internal', 'o.status'),
      col('created_at', 'Ordered', 'datetime', 'internal'),
    ],
  },
  {
    key: 'waitlists',
    label: 'Waitlists',
    description: 'Offering waitlist positions',
    table: 'waitlist_entries',
    requiredTables: ['waitlist_entries', 'people', 'registration_offerings'],
    joins: [
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
      {
        alias: 'o',
        table: 'registration_offerings',
        on: 'o.id = t.offering_id AND o.org_id = t.org_id',
      },
    ],
    roles: STAFF,
    columns: [
      col('id', 'Entry ID', 'text', 'internal'),
      col(
        'person_name',
        'Person',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
      col('offering_name', 'Offering', 'text', 'internal', 'o.name'),
      col('position', 'Position', 'number', 'internal'),
      col('status', 'Status', 'enum', 'internal'),
      col('offered_at', 'Offered', 'datetime', 'internal'),
      col('offer_expires_at', 'Offer expires', 'datetime', 'internal'),
      col('created_at', 'Joined', 'datetime', 'internal'),
    ],
  },
  // Datasets whose backing tables land with other phases. They stay visible in
  // the catalog with available=false until their tables exist.
  {
    key: 'volunteers',
    label: 'Volunteers',
    description: 'Volunteer shifts, signups and hours (Phase 11 tables)',
    table: 'volunteer_signups',
    requiredTables: [
      'volunteer_signups',
      'volunteer_shifts',
      'volunteer_roles',
      'people',
    ],
    joins: [
      {
        alias: 's',
        table: 'volunteer_shifts',
        on: 's.id = t.volunteer_shift_id AND s.org_id = t.org_id',
      },
      {
        alias: 'r',
        table: 'volunteer_roles',
        on: 'r.id = s.volunteer_role_id AND r.org_id = t.org_id',
      },
      {
        alias: 'p',
        table: 'people',
        on: 'p.id = t.person_id AND p.org_id = t.org_id',
      },
    ],
    roles: ['owner', 'admin', 'volunteer_coordinator', 'reporter'],
    columns: [
      col('id', 'Signup ID', 'text', 'internal'),
      col('status', 'Completion status', 'enum', 'internal'),
      col('hours_credited', 'Hours credited', 'number', 'internal'),
      col(
        'shift_starts_at',
        'Shift starts',
        'datetime',
        'internal',
        's.starts_at',
      ),
      col('role_name', 'Volunteer role', 'text', 'internal', 'r.name'),
      col(
        'person_name',
        'Volunteer',
        'text',
        'internal',
        "p.first_name || ' ' || p.last_name",
      ),
    ],
  },
  {
    key: 'evaluations',
    label: 'Evaluations',
    description: 'Tryout scores and results (Phase 6 tables)',
    table: 'evaluation_scores',
    requiredTables: ['evaluation_scores'],
    joins: [],
    roles: ['owner', 'admin', 'director', 'reporter'],
    columns: [col('id', 'Score ID', 'text', 'internal')],
  },
  {
    key: 'offers',
    label: 'Offers',
    description: 'Team offers (Phase 6 tables)',
    table: 'team_offers',
    requiredTables: ['team_offers'],
    joins: [],
    roles: ['owner', 'admin', 'director', 'reporter'],
    columns: [col('id', 'Offer ID', 'text', 'internal')],
  },
  {
    key: 'orders',
    label: 'Store orders',
    description: 'Store and uniform orders (Phase 11 tables)',
    table: 'orders',
    requiredTables: ['orders'],
    joins: [],
    roles: MONEY_ROLES,
    columns: [col('id', 'Order ID', 'text', 'internal')],
  },
];

export const datasetByKey = new Map(REPORT_DATASETS.map((d) => [d.key, d]));

/** Roles that may see each tier (04 §2). */
export function tierAllowed(
  roles: readonly string[],
  tier: DataTier,
  options: { registrarMedicalAccess?: boolean } = {},
): boolean {
  if (roles.includes('owner') || roles.includes('admin')) return true;
  switch (tier) {
    case 'public':
    case 'internal':
      return roles.some((r) => (STAFF as readonly string[]).includes(r));
    case 'sensitive':
      return roles.some((r) =>
        [
          'registrar',
          'finance',
          'scheduler',
          'compliance',
          'communications',
          'director',
          'volunteer_coordinator',
          'reporter',
        ].includes(r),
      );
    case 'restricted':
      return (
        roles.includes('compliance') ||
        (options.registrarMedicalAccess === true && roles.includes('registrar'))
      );
  }
}

/** Sensitive-tier exports require step-up auth; reporters are read-only. */
export function canExportTier(
  roles: readonly string[],
  tier: DataTier,
  stepUpAuthenticated: boolean,
): boolean {
  if (tier === 'public' || tier === 'internal') return true;
  if (!stepUpAuthenticated) return false;
  if (tier === 'sensitive')
    return roles.some((role) =>
      [
        'owner',
        'admin',
        'registrar',
        'finance',
        'scheduler',
        'compliance',
        'communications',
        'director',
        'volunteer_coordinator',
      ].includes(role),
    );
  return (
    roles.includes('owner') ||
    roles.includes('admin') ||
    roles.includes('compliance')
  );
}
