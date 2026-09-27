export type ComponentState = 'operational' | 'degraded';

export type PublicStatus = {
  status: ComponentState;
  components: {
    api: ComponentState;
    database: ComponentState;
    worker: ComponentState;
  };
};

export function publicStatus(input: {
  api: boolean;
  database: boolean;
  worker: boolean;
}): PublicStatus {
  const components = {
    api: input.api ? 'operational' : 'degraded',
    database: input.database ? 'operational' : 'degraded',
    worker: input.worker ? 'operational' : 'degraded',
  } satisfies PublicStatus['components'];
  const status = Object.values(components).every(
    (component) => component === 'operational',
  )
    ? 'operational'
    : 'degraded';
  return { status, components };
}

export function readinessResponse(databaseAvailable: boolean): {
  ready: boolean;
} {
  return { ready: databaseAvailable };
}
