// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { aiFeatureFlag } from './ai-feature';

describe('Vite AI feature flag', () => {
  it('enables AI only when Anthropic is selected with a configured key', () => {
    expect(
      aiFeatureFlag({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: ' test-only-placeholder ',
        VITE_AI_ENABLED: 'false',
      }),
    ).toBe('true');
  });

  it.each([
    { AI_PROVIDER: 'none', ANTHROPIC_API_KEY: 'test-only-placeholder' },
    { AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'test-only-placeholder' },
    { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' },
    { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '   ' },
    { AI_PROVIDER: 'anthropic' },
  ])('keeps AI disabled for incomplete or non-Anthropic config', (env) => {
    expect(aiFeatureFlag(env)).toBe('false');
  });
});
