export function aiFeatureFlag(
  environment: Record<string, string | undefined>,
): 'true' | 'false' {
  return environment.AI_PROVIDER === 'anthropic' &&
    Boolean(environment.ANTHROPIC_API_KEY?.trim())
    ? 'true'
    : 'false';
}
