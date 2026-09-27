import { z } from 'zod';

const cursorSchema = z.strictObject({
  version: z.literal(1),
  sort: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  id: z.uuid(),
});

export type PageCursor = z.infer<typeof cursorSchema>;
export type PageRequest = {
  limit: number;
  sort: string;
  cursor: PageCursor | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };

export function encodeCursor(cursor: Omit<PageCursor, 'version'>): string {
  return Buffer.from(
    JSON.stringify(cursorSchema.parse({ version: 1, ...cursor })),
  ).toString('base64url');
}

export function decodeCursor(
  encoded: string,
  expectedSort: string,
): PageCursor {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(encoded))
    throw new RangeError('Invalid page cursor');
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    );
    const cursor = cursorSchema.parse(parsed);
    if (cursor.sort !== expectedSort)
      throw new RangeError('Cursor sort does not match request');
    return cursor;
  } catch {
    throw new RangeError('Invalid page cursor');
  }
}

export function parsePageRequest(
  query: Record<string, unknown>,
  allowedSorts: readonly string[],
  defaultSort: string,
): PageRequest {
  if (!allowedSorts.includes(defaultSort))
    throw new RangeError('Default sort is not allowed');
  const sort =
    query.sort === undefined ? defaultSort : z.string().parse(query.sort);
  if (!allowedSorts.includes(sort))
    throw new RangeError('Sort field is not allowed');
  const limit =
    query.limit === undefined
      ? 50
      : Number(z.string().regex(/^\d+$/).parse(query.limit));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Page limit must be 1–200');
  const cursor =
    query.cursor === undefined
      ? null
      : decodeCursor(z.string().parse(query.cursor), sort);
  return { limit, sort, cursor };
}

export function pageFromRows<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => Omit<PageCursor, 'version'>,
): Page<T> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Page limit must be 1–200');
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: [...items],
    nextCursor:
      rows.length > limit && last ? encodeCursor(cursorOf(last)) : null,
  };
}
