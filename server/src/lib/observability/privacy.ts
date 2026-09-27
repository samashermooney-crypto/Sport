const safeEventLevels = new Set(['fatal', 'error', 'warning', 'info', 'debug']);
const safeTagNames = new Set([
  'module',
  'operation',
  'component',
  'status_code',
  'http.method',
  'environment',
]);

type StackFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function safeFrame(value: unknown): StackFrame | undefined {
  if (!isRecord(value)) return undefined;
  const filename = safeString(value.filename, /^[A-Za-z0-9_./@-]{1,240}$/);
  const fn = safeString(value.function, /^[A-Za-z0-9_.$<>-]{1,160}$/);
  const lineno =
    typeof value.lineno === 'number' && Number.isSafeInteger(value.lineno)
      ? value.lineno
      : undefined;
  const colno =
    typeof value.colno === 'number' && Number.isSafeInteger(value.colno)
      ? value.colno
      : undefined;
  return {
    ...(filename ? { filename } : {}),
    ...(fn ? { function: fn } : {}),
    ...(lineno !== undefined ? { lineno } : {}),
    ...(colno !== undefined ? { colno } : {}),
  };
}

/** Return a small allowlisted event; arbitrary Sentry event context is discarded. */
export function scrubSentryEvent(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  const eventId = safeString(value.event_id, /^[a-f0-9]{32}$/i);
  const platform = safeString(value.platform, /^[a-z-]{1,24}$/);
  const release = safeString(value.release, /^[A-Za-z0-9_.+-]{1,100}$/);
  const environment = safeString(value.environment, /^[A-Za-z0-9_.-]{1,40}$/);
  if (eventId) result.event_id = eventId;
  if (platform) result.platform = platform;
  if (release) result.release = release;
  if (environment) result.environment = environment;
  if (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)) {
    result.timestamp = value.timestamp;
  }
  if (typeof value.level === 'string' && safeEventLevels.has(value.level))
    result.level = value.level;

  if (isRecord(value.tags)) {
    const tags: Record<string, string> = {};
    for (const [key, tag] of Object.entries(value.tags)) {
      if (
        safeTagNames.has(key) &&
        typeof tag === 'string' &&
        /^[A-Za-z0-9_.:/-]{1,80}$/.test(tag)
      ) {
        tags[key] = tag;
      }
    }
    if (Object.keys(tags).length) result.tags = tags;
  }

  if (isRecord(value.exception) && Array.isArray(value.exception.values)) {
    const values = value.exception.values.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const type = safeString(entry.type, /^[A-Za-z0-9_.:$-]{1,120}$/);
      const rawStack = isRecord(entry.stacktrace)
        ? entry.stacktrace.frames
        : undefined;
      const frames = Array.isArray(rawStack)
        ? rawStack.map(safeFrame).filter((frame) => frame !== undefined)
        : undefined;
      return [
        {
          ...(type ? { type } : {}),
          value: '[redacted]',
          ...(frames?.length
            ? { stacktrace: { frames: frames.slice(-40) } }
            : {}),
        },
      ];
    });
    if (values.length) result.exception = { values: values.slice(-10) };
  }

  return result;
}

/** Drop all user activity breadcrumbs because their free-text fields are unsafe. */
export function scrubSentryBreadcrumb(): null {
  return null;
}
