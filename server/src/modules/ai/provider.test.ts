import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AiDisabledProvider,
  AnthropicProvider,
  createAiProvider,
  FakeAiProvider,
} from './provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI providers', () => {
  it('keeps AI disabled unless Anthropic is explicitly configured', async () => {
    const disabled = createAiProvider({});
    expect(disabled).toBeInstanceOf(AiDisabledProvider);
    expect(disabled.enabled).toBe(false);
    await expect(disabled.complete([])).rejects.toThrow('AI is disabled');

    const missingKey = createAiProvider({ AI_PROVIDER: 'anthropic' });
    expect(missingKey).toBeInstanceOf(AiDisabledProvider);
  });

  it('uses configured Anthropic model and base URL', () => {
    const provider = createAiProvider({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key',
      AI_MODEL: 'claude-test',
      AI_BASE_URL: 'https://anthropic.example.test',
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider).toMatchObject({
      name: 'anthropic',
      model: 'claude-test',
      enabled: true,
    });
  });

  it('returns deterministic fake responses and token estimates', async () => {
    const provider = new FakeAiProvider('fixture-model');
    provider.handler = () => 'draft';
    const messages = [{ role: 'user' as const, content: 'hello!' }];

    await expect(provider.complete(messages)).resolves.toEqual({
      text: 'draft',
      promptTokens: 2,
      completionTokens: 2,
    });
    expect(provider.calls).toEqual([messages]);
    expect(provider.model).toBe('fixture-model');
  });

  it('sends system instructions separately and parses Anthropic usage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: 'Season ' },
            { type: 'tool_use', name: 'ignored' },
            { type: 'text', text: 'draft' },
          ],
          usage: { input_tokens: 17, output_tokens: 8 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider(
      'test-key',
      'claude-test',
      'https://anthropic.example.test',
    );

    const result = await provider.complete([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Draft a schedule' },
      { role: 'assistant', content: 'Use two fields' },
    ]);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl).toBe('https://anthropic.example.test/v1/messages');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
    });
    const requestBody = requestInit?.body;
    expect(typeof requestBody).toBe('string');
    expect(requestBody).toBe(
      JSON.stringify({
        model: 'claude-test',
        max_tokens: 4096,
        system: 'Be concise',
        messages: [
          { role: 'user', content: 'Draft a schedule' },
          { role: 'assistant', content: 'Use two fields' },
        ],
      }),
    );
    expect(result).toEqual({
      text: 'Season draft',
      promptTokens: 17,
      completionTokens: 8,
    });
  });

  it('rejects provider errors and safely handles missing response fields', async () => {
    const provider = new AnthropicProvider('test-key', 'claude-test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.complete([])).rejects.toThrow(
      'Anthropic request failed: 503',
    );
    await expect(provider.complete([])).resolves.toEqual({
      text: '',
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.anthropic.com/v1/messages',
    );
  });
});
