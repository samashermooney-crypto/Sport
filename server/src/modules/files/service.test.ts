import { describe, expect, it } from 'vitest';

import { sniffMime } from './service';

describe('file content inspection', () => {
  it('identifies supported magic bytes', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'))).toBe(
      'application/pdf',
    );
    expect(sniffMime(new TextEncoder().encode('a,b\n'))).toBe('text/csv');
    expect(sniffMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
