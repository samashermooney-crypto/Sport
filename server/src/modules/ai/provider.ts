export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletion {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface AiProvider {
  name: string;
  model: string;
  enabled: boolean;
  complete(messages: AiMessage[]): Promise<AiCompletion>;
}

export class AiDisabledProvider implements AiProvider {
  readonly name = 'disabled';
  readonly model = '';
  readonly enabled = false;
  complete(): Promise<AiCompletion> {
    return Promise.reject(new Error('AI is disabled'));
  }
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly enabled = true;
  calls: AiMessage[][] = [];
  handler: ((messages: AiMessage[]) => string) | null = null;

  constructor(model = 'fake-1') {
    this.model = model;
  }

  complete(messages: AiMessage[]): Promise<AiCompletion> {
    this.calls.push(messages);
    const text =
      this.handler?.(messages) ??
      'Fake provider response: no handler configured';
    return Promise.resolve({
      text,
      promptTokens: messages.reduce(
        (sum, message) => sum + Math.ceil(message.content.length / 4),
        0,
      ),
      completionTokens: Math.ceil(text.length / 4),
    });
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly enabled = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ?? 'https://api.anthropic.com';
  }

  async complete(messages: AiMessage[]): Promise<AiCompletion> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const chat = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: chat,
      }),
    });
    if (!response.ok)
      throw new Error(`Anthropic request failed: ${response.status}`);
    const body = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text =
      body.content
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('') ?? '';
    return {
      text,
      promptTokens: body.usage?.input_tokens ?? 0,
      completionTokens: body.usage?.output_tokens ?? 0,
    };
  }
}

export function createAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const provider = env['AI_PROVIDER'];
  if (provider === 'anthropic') {
    const apiKey = env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      // Misconfigured: stay disabled rather than call a real API unauthenticated.
      return new AiDisabledProvider();
    }
    return new AnthropicProvider(
      apiKey,
      env['AI_MODEL'] ?? 'claude-sonnet-5',
      env['AI_BASE_URL'],
    );
  }
  if (provider === 'fake') return new FakeAiProvider(env['AI_MODEL']);
  return new AiDisabledProvider();
}
