import { version } from 'uuid';
import { expect, it } from 'vitest';

import { isUuidV7, newId } from './ids';

it('creates valid UUIDv7 identifiers', () => {
  const id = newId();
  expect(isUuidV7(id)).toBe(true);
  expect(version(id)).toBe(7);
  expect(isUuidV7('not-a-uuid')).toBe(false);
});
