import type { ImportIssue } from './phase15-schema';

export function issue(
  level: 'error' | 'warning',
  code: string,
  message: string,
  field?: string,
): ImportIssue {
  return { level, code, message, ...(field ? { field } : {}) };
}

const DATE_EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function parseDate(
  raw: string,
  field: string,
): { value: string | null; issue: ImportIssue | null } {
  const value = raw.trim();
  if (!value) return { value: null, issue: null };
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const y = iso[1] ?? '';
    const m = iso[2] ?? '';
    const d = iso[3] ?? '';
    return {
      value: `${y}-${m}-${d}`,
      issue: validDate(Number(y), Number(m), Number(d))
        ? null
        : issue(
            'error',
            'INVALID_DATE',
            `"${value}" is not a real date`,
            field,
          ),
    };
  }
  const us =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value) ??
    /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value);
  if (us) {
    const m = us[1] ?? '';
    const d = us[2] ?? '';
    const y = us[3] ?? '';
    if (validDate(Number(y), Number(m), Number(d))) {
      return {
        value: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
        issue: null,
      };
    }
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_DATE',
        `"${value}" is not a real date; use YYYY-MM-DD or MM/DD/YYYY`,
        field,
      ),
    };
  }
  if (/^\d{1,2}\/\d{1,2}$/.test(value)) {
    return {
      value: null,
      issue: issue(
        'error',
        'AMBIGUOUS_DATE',
        `"${value}" is ambiguous; use YYYY-MM-DD or MM/DD/YYYY with a 4-digit year`,
        field,
      ),
    };
  }
  if (/^\d{5}(?:\.\d+)?$/.test(value)) {
    const serial = Number(value);
    const ms = DATE_EXCEL_EPOCH + serial * 86_400_000;
    return {
      value: new Date(ms).toISOString().slice(0, 10),
      issue: null,
    };
  }
  return {
    value: null,
    issue: issue(
      'error',
      'INVALID_DATE',
      `"${value}" is not a recognized date; use YYYY-MM-DD or MM/DD/YYYY`,
      field,
    ),
  };
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseTime(
  raw: string,
  field: string,
): { value: string | null; issue: ImportIssue | null } {
  const value = raw.trim();
  if (!value) return { value: null, issue: null };
  const match =
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(value) ??
    /^(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)$/i.exec(value);
  if (!match)
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_TIME',
        `"${value}" is not a recognized time; use HH:MM or h:MM AM/PM`,
        field,
      ),
    };
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[4] ?? match[3];
  if (meridiem) {
    if (hour === 12) hour = 0;
    if (/p/i.test(meridiem)) hour += 12;
  }
  if (hour > 23 || minute > 59)
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_TIME',
        `"${value}" is not a real time`,
        field,
      ),
    };
  return {
    value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    issue: null,
  };
}

export function parsePhone(
  raw: string,
  field: string,
): { value: string | null; issue: ImportIssue | null } {
  const value = raw.trim();
  if (!value) return { value: null, issue: null };
  const digits = value.replaceAll(/\D/g, '');
  const national =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10) return { value: `+1${national}`, issue: null };
  if (digits.length >= 8 && digits.length <= 15 && value.startsWith('+'))
    return { value: `+${digits}`, issue: null };
  return {
    value: null,
    issue: issue(
      'warning',
      'PHONE_DROPPED',
      `"${value}" could not be normalized to E.164; add an area code and country code`,
      field,
    ),
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseEmail(
  raw: string,
  field: string,
): { value: string | null; issue: ImportIssue | null } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: null, issue: null };
  if (!EMAIL_PATTERN.test(value))
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_EMAIL',
        `"${value}" is not a valid email`,
        field,
      ),
    };
  return { value, issue: null };
}

export function parseMoney(
  raw: string,
  field: string,
): { value: number | null; issue: ImportIssue | null } {
  const value = raw.trim();
  if (!value) return { value: null, issue: null };
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned))
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_MONEY',
        `"${value}" is not a valid amount; use dollars like 123.45`,
        field,
      ),
    };
  return { value: Math.round(Number(cleaned) * 100), issue: null };
}

export function parseBool(
  raw: string,
  field: string,
): { value: boolean | null; issue: ImportIssue | null } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: null, issue: null };
  if (['yes', 'y', 'true', '1', 'x'].includes(value))
    return { value: true, issue: null };
  if (['no', 'n', 'false', '0'].includes(value))
    return { value: false, issue: null };
  return {
    value: null,
    issue: issue('error', 'INVALID_BOOL', `"${value}" is not yes/no`, field),
  };
}

export function parseInt_(
  raw: string,
  field: string,
): { value: number | null; issue: ImportIssue | null } {
  const value = raw.trim();
  if (!value) return { value: null, issue: null };
  if (!/^-?\d+$/.test(value))
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_INTEGER',
        `"${value}" is not a whole number`,
        field,
      ),
    };
  return { value: Number(value), issue: null };
}

export function parseGender(
  raw: string,
  field: string,
): { value: string | null; issue: ImportIssue | null } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: null, issue: null };
  const map: Record<string, string> = {
    f: 'female',
    female: 'female',
    girl: 'female',
    m: 'male',
    male: 'male',
    boy: 'male',
    nonbinary: 'nonbinary',
    'non-binary': 'nonbinary',
    nb: 'nonbinary',
    unspecified: 'unspecified',
    unknown: 'unspecified',
    u: 'unspecified',
  };
  const mapped = map[value];
  if (!mapped)
    return {
      value: null,
      issue: issue(
        'error',
        'INVALID_GENDER',
        `"${value}" is not a recognized gender value`,
        field,
      ),
    };
  return { value: mapped, issue: null };
}

export function parseEnum(
  raw: string,
  field: string,
  allowed: readonly string[],
  labels: Record<string, string> = {},
): { value: string | null; issue: ImportIssue | null } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: null, issue: null };
  const normalized = value.replaceAll(/[\s-]+/g, '_');
  if (allowed.includes(normalized)) return { value: normalized, issue: null };
  const byLabel = labels[value];
  if (byLabel) return { value: byLabel, issue: null };
  return {
    value: null,
    issue: issue(
      'error',
      'INVALID_VALUE',
      `"${raw.trim()}" is not one of: ${allowed.join(', ')}`,
      field,
    ),
  };
}

export function parseList(raw: string): string[] {
  return raw
    .split(/[;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
