import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  pageFromRows,
  parsePageRequest,
} from './pagination';

describe('cursor pagination', () => {
  it('uses safe defaults and round-trips opaque keyset cursors', () => {
    expect(parsePageRequest({}, ['created_at'], 'created_at')).toEqual({
      limit: 50,
      sort: 'created_at',
      cursor: null,
    });
    const id = randomUUID();
    const encoded = encodeCursor({
      sort: 'created_at',
      value: '2026-09-01T00:00:00Z',
      id,
    });
    expect(decodeCursor(encoded, 'created_at')).toEqual({
      version: 1,
      sort: 'created_at',
      value: '2026-09-01T00:00:00Z',
      id,
    });
    expect(
      parsePageRequest(
        { cursor: encoded, limit: '200' },
        ['created_at'],
        'created_at',
      ).limit,
    ).toBe(200);
  });

  it('emits the last returned row as next cursor only when another row exists', () => {
    const rows = [randomUUID(), randomUUID(), randomUUID()];
    const page = pageFromRows(rows, 2, (id) => ({ sort: 'id', value: id, id }));
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodeCursor(page.nextCursor ?? '', 'id').id).toBe(rows[1]);
    expect(
      pageFromRows(rows, 3, (id) => ({ sort: 'id', value: id, id })).nextCursor,
    ).toBeNull();
  });

  it('rejects sort injection, oversized pages and corrupt cursors', () => {
    expect(() =>
      parsePageRequest({ sort: 'name;DROP TABLE accounts' }, ['name'], 'name'),
    ).toThrow();
    expect(() => parsePageRequest({ limit: '201' }, ['id'], 'id')).toThrow();
    expect(() => decodeCursor('not-valid!', 'id')).toThrow();
    expect(() =>
      decodeCursor(
        encodeCursor({ sort: 'name', value: 1, id: randomUUID() }),
        'id',
      ),
    ).toThrow();
  });
});
