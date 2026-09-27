import type { ImportField, ImportKind } from '@shared/schemas/imports';

function field(
  key: string,
  label: string,
  type: ImportField['type'],
  description: string,
  options: Partial<Pick<ImportField, 'required' | 'enum' | 'aliases'>> = {},
): ImportField {
  return {
    key,
    label,
    type,
    description,
    required: options.required ?? false,
    ...(options.enum ? { enum: options.enum } : {}),
    aliases: options.aliases ?? [],
  };
}

const personFields: ImportField[] = [
  field('first_name', 'First name', 'text', 'Given name', {
    required: true,
    aliases: ['first', 'fname', 'given name', 'player first name'],
  }),
  field('last_name', 'Last name', 'text', 'Family name', {
    required: true,
    aliases: ['last', 'lname', 'surname', 'family name', 'player last name'],
  }),
  field('preferred_name', 'Preferred name', 'text', 'Name the person goes by', {
    aliases: ['nickname', 'preferred', 'goes by'],
  }),
  field('middle_name', 'Middle name', 'text', 'Middle name', {
    aliases: ['middle', 'middle initial'],
  }),
  field('suffix', 'Suffix', 'text', 'Name suffix such as Jr. or III'),
  field('date_of_birth', 'Date of birth', 'date', 'YYYY-MM-DD or MM/DD/YYYY', {
    aliases: ['dob', 'birth date', 'birthdate', 'birthday'],
  }),
  field('gender', 'Gender', 'gender', 'female, male, nonbinary or unspecified'),
  field('email', 'Email', 'email', 'Contact email', {
    aliases: ['e-mail', 'email address', 'contact email'],
  }),
  field('phone', 'Phone', 'phone', 'Mobile or home phone', {
    aliases: ['phone number', 'mobile', 'cell', 'telephone'],
  }),
  field('address_line1', 'Address line 1', 'text', 'Street address', {
    aliases: ['address', 'street', 'address 1', 'street address'],
  }),
  field('address_line2', 'Address line 2', 'text', 'Apartment or unit', {
    aliases: ['address 2', 'apt', 'unit'],
  }),
  field('city', 'City', 'text', 'City'),
  field('state', 'State', 'text', 'State or province', {
    aliases: ['province', 'region'],
  }),
  field('postal_code', 'Postal code', 'text', 'ZIP or postal code', {
    aliases: ['zip', 'zip code', 'postal', 'postcode'],
  }),
  field(
    'graduation_year',
    'Graduation year',
    'int',
    'High school graduation year',
    {
      aliases: ['grad year', 'class of'],
    },
  ),
  field('school_name', 'School', 'text', 'School name', {
    aliases: ['school'],
  }),
  field(
    'household_name',
    'Household',
    'text',
    'Shared household name for grouping',
    {
      aliases: ['household', 'family', 'family name'],
    },
  ),
  field(
    'member_role',
    'Household role',
    'enum',
    'guardian, athlete, other_adult or other_child',
    {
      enum: ['guardian', 'athlete', 'other_adult', 'other_child'],
      aliases: ['role', 'relationship', 'household role'],
    },
  ),
  field('ec_name', 'Emergency contact', 'text', 'Emergency contact name', {
    aliases: ['emergency contact', 'ec name', 'emergency name'],
  }),
  field('ec_phone', 'Emergency phone', 'phone', 'Emergency contact phone', {
    aliases: ['ec phone', 'emergency phone', 'emergency contact phone'],
  }),
  field('ec_note', 'Emergency note', 'text', 'Emergency contact note', {
    aliases: ['ec note', 'emergency note'],
  }),
];

const householdFields: ImportField[] = [
  field('household_name', 'Household name', 'text', 'e.g. "Rivera Family"', {
    required: true,
    aliases: ['household', 'family', 'family name', 'account name'],
  }),
  field('member_first_name', 'Member first name', 'text', '', {
    required: true,
    aliases: ['first name', 'first', 'member first'],
  }),
  field('member_last_name', 'Member last name', 'text', '', {
    required: true,
    aliases: ['last name', 'last', 'member last'],
  }),
  field(
    'member_email',
    'Member email',
    'email',
    'Matches an existing person when present',
    {
      aliases: ['email', 'member email', 'e-mail'],
    },
  ),
  field(
    'member_role',
    'Member role',
    'enum',
    'guardian, athlete, other_adult or other_child',
    {
      required: true,
      enum: ['guardian', 'athlete', 'other_adult', 'other_child'],
      aliases: ['role', 'relationship'],
    },
  ),
  field('member_dob', 'Member date of birth', 'date', '', {
    aliases: ['dob', 'birth date', 'member dob'],
  }),
  field(
    'financially_responsible',
    'Financially responsible',
    'bool',
    'yes/no',
    {
      aliases: ['pays', 'billing', 'responsible'],
    },
  ),
  field('is_primary_contact', 'Primary contact', 'bool', 'yes/no', {
    aliases: ['primary', 'primary contact'],
  }),
  field('can_pick_up', 'Pickup authorized', 'bool', 'yes/no', {
    aliases: ['pickup', 'pick up'],
  }),
  field('address_line1', 'Address line 1', 'text', '', {
    aliases: ['address', 'street'],
  }),
  field('city', 'City', 'text', ''),
  field('state', 'State', 'text', ''),
  field('postal_code', 'Postal code', 'text', '', {
    aliases: ['zip', 'zip code'],
  }),
];

const registrationFields: ImportField[] = [
  field(
    'person_email',
    'Participant email',
    'email',
    'Email of an existing person',
    {
      aliases: ['email', 'player email', 'athlete email', 'registrant email'],
    },
  ),
  field(
    'first_name',
    'Participant first name',
    'text',
    'Used with last name + birth date when email is absent',
    {
      aliases: ['first', 'player first name'],
    },
  ),
  field('last_name', 'Participant last name', 'text', '', {
    aliases: ['last', 'player last name'],
  }),
  field('date_of_birth', 'Participant date of birth', 'date', '', {
    aliases: ['dob', 'birth date'],
  }),
  field('program', 'Program', 'text', 'Program name or slug', {
    required: true,
    aliases: ['program name', 'programme', 'league'],
  }),
  field('division', 'Division', 'text', 'Division name or age label', {
    aliases: ['division name', 'age group', 'age_label'],
  }),
  field('offering', 'Offering', 'text', 'Registration offering name', {
    aliases: ['offering name', 'option', 'registration option'],
  }),
  field('status', 'Status', 'enum', 'confirmed, canceled or withdrawn', {
    enum: ['confirmed', 'canceled', 'withdrawn'],
    aliases: ['registration status'],
  }),
  field('team', 'Team', 'text', 'Team name for placement', {
    aliases: ['team name'],
  }),
  field(
    'registered_on',
    'Registered on',
    'date',
    'Original registration date',
    {
      aliases: ['registration date', 'registered'],
    },
  ),
];

const teamFields: ImportField[] = [
  field('name', 'Team name', 'text', '', {
    required: true,
    aliases: ['team', 'team name'],
  }),
  field(
    'program',
    'Program',
    'text',
    'Program name or slug (creates a team season)',
    {
      aliases: ['program name', 'league'],
    },
  ),
  field('division', 'Division', 'text', 'Division name or age label', {
    aliases: ['division name', 'age group'],
  }),
  field('short_name', 'Short name', 'text', '', {
    aliases: ['abbreviation', 'short'],
  }),
  field('birth_year', 'Birth year', 'int', 'Birth-year team (club)', {
    aliases: ['birthyear', 'year'],
  }),
  field('age_label', 'Age label', 'text', 'e.g. U12, 14U', {
    aliases: ['age group', 'age'],
  }),
  field(
    'level',
    'Level',
    'enum',
    'recreational, developmental, competitive or elite',
    {
      enum: ['recreational', 'developmental', 'competitive', 'elite', 'open'],
    },
  ),
  field(
    'competition_gender',
    'Competition gender',
    'enum',
    'female, male or open',
    {
      enum: ['female', 'male', 'open'],
      aliases: ['gender'],
    },
  ),
];

const rosterFields: ImportField[] = [
  field('team', 'Team name', 'text', '', {
    required: true,
    aliases: ['team', 'team name'],
  }),
  field('program', 'Program', 'text', 'Program name or slug', {
    aliases: ['program name', 'league', 'season'],
  }),
  field('person_email', 'Person email', 'email', 'Matches an existing person', {
    aliases: ['email', 'player email'],
  }),
  field('first_name', 'First name', 'text', 'Required when email is absent', {
    aliases: ['first', 'player first name'],
  }),
  field('last_name', 'Last name', 'text', '', {
    aliases: ['last', 'player last name'],
  }),
  field('date_of_birth', 'Date of birth', 'date', '', {
    aliases: ['dob', 'birth date'],
  }),
  field(
    'role',
    'Role',
    'enum',
    'player, goalkeeper (roster) or head_coach, assistant_coach, team_manager, trainer, treasurer (staff)',
    {
      enum: [
        'player',
        'rostered',
        'guest',
        'practice_only',
        'head_coach',
        'assistant_coach',
        'team_manager',
        'trainer',
        'treasurer',
      ],
      aliases: ['position role', 'staff role'],
    },
  ),
  field('jersey_number', 'Jersey number', 'text', '', {
    aliases: ['jersey', 'number', '#'],
  }),
  field('positions', 'Positions', 'list', 'Separated by ; or |', {
    aliases: ['position'],
  }),
  field('joined_on', 'Joined on', 'date', '', {
    aliases: ['joined', 'start date'],
  }),
];

const scheduleFields: ImportField[] = [
  field('title', 'Title', 'text', 'Event title', {
    aliases: ['name', 'event', 'event name'],
  }),
  field(
    'kind',
    'Kind',
    'enum',
    'game, practice, meet, match, tournament_game, meeting, other',
    {
      enum: [
        'game',
        'practice',
        'meet',
        'match',
        'bout_session',
        'class_session',
        'tournament_game',
        'meeting',
        'volunteer_shift',
        'other',
      ],
      aliases: ['type', 'event type'],
    },
  ),
  field('date', 'Date', 'date', 'Event date', {
    required: true,
    aliases: ['event date', 'day'],
  }),
  field('start_time', 'Start time', 'time', 'HH:MM or h:MM AM/PM', {
    required: true,
    aliases: ['start', 'time', 'start time'],
  }),
  field('end_time', 'End time', 'time', '', { aliases: ['end', 'end time'] }),
  field(
    'duration_minutes',
    'Duration (minutes)',
    'int',
    'Used when no end time',
    {
      aliases: ['duration', 'length'],
    },
  ),
  field(
    'timezone',
    'Timezone',
    'text',
    'IANA name; defaults to the organization timezone',
    {
      aliases: ['tz', 'time zone'],
    },
  ),
  field('facility', 'Facility', 'text', 'Facility name', {
    aliases: ['facility name', 'venue', 'location name'],
  }),
  field('space', 'Space', 'text', 'Space name within the facility', {
    aliases: ['field', 'court', 'space name'],
  }),
  field(
    'location_text',
    'Location text',
    'text',
    'Free-text location when not an org space',
    {
      aliases: ['location', 'address'],
    },
  ),
  field('home_team', 'Home team', 'text', 'Team name', {
    aliases: ['home', 'home team name'],
  }),
  field('away_team', 'Away team', 'text', 'Team or external opponent name', {
    aliases: ['away', 'away team name', 'visitor', 'opponent'],
  }),
  field('program', 'Program', 'text', 'Program name or slug', {
    aliases: ['program name', 'league'],
  }),
  field('published', 'Published', 'bool', 'yes/no (default yes)', {
    aliases: ['visible', 'is published'],
  }),
];

const facilityFields: ImportField[] = [
  field('facility_name', 'Facility name', 'text', '', {
    required: true,
    aliases: ['facility', 'name', 'venue'],
  }),
  field('address_line1', 'Address line 1', 'text', '', {
    aliases: ['address', 'street', 'address 1'],
  }),
  field('city', 'City', 'text', ''),
  field('state', 'State', 'text', ''),
  field('postal_code', 'Postal code', 'text', '', {
    aliases: ['zip', 'zip code'],
  }),
  field(
    'timezone',
    'Timezone',
    'text',
    'IANA name; defaults to the organization timezone',
    {
      aliases: ['tz', 'time zone'],
    },
  ),
  field('ownership', 'Ownership', 'enum', 'owned, permitted or partner', {
    enum: ['owned', 'permitted', 'partner'],
  }),
  field('public', 'Public', 'bool', 'yes/no (default yes)', {}),
  field(
    'space_name',
    'Space name',
    'text',
    'Field, court or room within the facility',
    {
      aliases: ['space', 'field', 'court', 'field name'],
    },
  ),
  field(
    'space_kind',
    'Space kind',
    'enum',
    'field, court, rink, pool, lanes, mat, diamond, track, room or other',
    {
      enum: [
        'field',
        'court',
        'rink',
        'pool',
        'lanes',
        'mat',
        'diamond',
        'track',
        'room',
        'other',
      ],
      aliases: ['kind', 'type'],
    },
  ),
  field('surface', 'Surface', 'text', 'e.g. turf, grass, hardwood'),
  field('has_lights', 'Lights', 'bool', 'yes/no', { aliases: ['lights'] }),
  field('capacity_people', 'Capacity', 'int', 'People capacity', {
    aliases: ['capacity'],
  }),
];

const credentialFields: ImportField[] = [
  field('person_email', 'Person email', 'email', 'Matches an existing person', {
    aliases: ['email', 'staff email', 'coach email'],
  }),
  field('first_name', 'First name', 'text', 'Required when email is absent', {
    aliases: ['first'],
  }),
  field('last_name', 'Last name', 'text', '', { aliases: ['last'] }),
  field(
    'credential_type',
    'Credential type',
    'text',
    'Existing type name or key; unknown types are created as manual-review types',
    {
      required: true,
      aliases: ['credential', 'type', 'certification', 'certification type'],
    },
  ),
  field('issued_on', 'Issued on', 'date', '', {
    aliases: ['issued', 'issue date'],
  }),
  field('expires_on', 'Expires on', 'date', '', {
    aliases: ['expires', 'expiration', 'expiration date', 'expiry'],
  }),
  field(
    'status',
    'Status',
    'enum',
    'verified, pending_review or expired (default verified)',
    {
      enum: ['verified', 'pending_review', 'expired'],
    },
  ),
  field(
    'identifier',
    'Identifier',
    'text',
    'License or membership number (stored encrypted)',
    {
      aliases: [
        'license',
        'license number',
        'member id',
        'certification number',
      ],
    },
  ),
  field(
    'document_file',
    'Document file',
    'text',
    'File name inside the uploaded zip archive',
    {
      aliases: ['document', 'file', 'attachment'],
    },
  ),
];

const historicalPaymentFields: ImportField[] = [
  field('payer_email', 'Payer email', 'email', 'Matches a person or account', {
    aliases: ['email', 'email address'],
  }),
  field('payer_first_name', 'Payer first name', 'text', '', {
    aliases: ['first name', 'first'],
  }),
  field('payer_last_name', 'Payer last name', 'text', '', {
    aliases: ['last name', 'last'],
  }),
  field('amount', 'Amount', 'money', 'Amount paid in dollars', {
    required: true,
    aliases: ['amount paid', 'total', 'payment', 'payment amount'],
  }),
  field('paid_on', 'Paid on', 'date', 'Payment date', {
    required: true,
    aliases: ['date', 'payment date', 'date paid'],
  }),
  field(
    'method',
    'Method',
    'enum',
    'cash, check, card or other (recorded as external history, never re-charged)',
    {
      enum: ['cash', 'check', 'card', 'external'],
      aliases: ['payment method', 'tender'],
    },
  ),
  field(
    'reference',
    'Reference',
    'text',
    'Check number or external receipt id',
    {
      aliases: ['check number', 'receipt', 'transaction id', 'confirmation'],
    },
  ),
  field('description', 'Description', 'text', 'What the payment covered', {
    aliases: ['memo', 'item', 'for'],
  }),
  field('program', 'Program', 'text', 'Program name for reporting', {
    aliases: ['program name', 'league'],
  }),
];

const volunteerHourFields: ImportField[] = [
  field('person_email', 'Person email', 'email', 'Matches an existing person', {
    aliases: ['email', 'volunteer email'],
  }),
  field('first_name', 'First name', 'text', 'Required when email is absent', {
    aliases: ['first', 'volunteer first name'],
  }),
  field('last_name', 'Last name', 'text', '', {
    aliases: ['last', 'volunteer last name'],
  }),
  field('role', 'Volunteer role', 'text', 'e.g. Concessions, Field setup', {
    aliases: ['volunteer role', 'job', 'position'],
  }),
  field('hours', 'Hours', 'money', 'Hours worked (decimal allowed)', {
    required: true,
    aliases: ['hour', 'hours worked', 'credit hours'],
  }),
  field('occurred_on', 'Date', 'date', 'When the work happened', {
    aliases: ['date', 'worked on', 'shift date'],
  }),
  field('notes', 'Notes', 'text', '', { aliases: ['note', 'memo'] }),
];

export const importFields: Record<ImportKind, ImportField[]> = {
  people: personFields,
  households: householdFields,
  registrations: registrationFields,
  teams: teamFields,
  rosters: rosterFields,
  schedule: scheduleFields,
  facilities: facilityFields,
  credentials: credentialFields,
  historical_payments: historicalPaymentFields,
  volunteer_hours: volunteerHourFields,
};
