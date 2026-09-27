export type LogLevel = 'info' | 'warn' | 'error';

export type SafeLogFields = {
  requestId?: string;
  operation?: string;
  module?: string;
  statusCode?: number;
  durationMs?: number;
  count?: number;
  result?: 'ok' | 'failed' | 'skipped';
};

const safeIdentifier = /^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$/;

export function structuredLogRecord(
  level: LogLevel,
  event: string,
  fields: SafeLogFields = {},
  timestamp = new Date(),
): string {
  if (!safeIdentifier.test(event)) throw new Error('Log event name is invalid');
  const record = {
    timestamp: timestamp.toISOString(),
    level,
    event,
    ...(fields.requestId && safeIdentifier.test(fields.requestId)
      ? { requestId: fields.requestId }
      : {}),
    ...(fields.operation && safeIdentifier.test(fields.operation)
      ? { operation: fields.operation }
      : {}),
    ...(fields.module && safeIdentifier.test(fields.module)
      ? { module: fields.module }
      : {}),
    ...(typeof fields.statusCode === 'number' &&
    Number.isSafeInteger(fields.statusCode)
      ? { statusCode: fields.statusCode }
      : {}),
    ...(typeof fields.durationMs === 'number' &&
    Number.isFinite(fields.durationMs) &&
    fields.durationMs >= 0
      ? { durationMs: fields.durationMs }
      : {}),
    ...(typeof fields.count === 'number' &&
    Number.isSafeInteger(fields.count) &&
    fields.count >= 0
      ? { count: fields.count }
      : {}),
    ...(fields.result ? { result: fields.result } : {}),
  };
  return JSON.stringify(record);
}

export function writeStructuredLog(
  level: LogLevel,
  event: string,
  fields: SafeLogFields = {},
): void {
  process.stdout.write(`${structuredLogRecord(level, event, fields)}\n`);
}
