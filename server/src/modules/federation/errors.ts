export class FederationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function federationNotFound(message = 'Federation resource not found') {
  return new FederationError(404, 'NOT_FOUND', message);
}

export function federationConflict(message: string) {
  return new FederationError(409, 'FEDERATION_CONFLICT', message);
}

export function federationUnprocessable(message: string) {
  return new FederationError(422, 'FEDERATION_RULE', message);
}

export function federationUnavailable(message: string) {
  return new FederationError(503, 'FEDERATION_UNAVAILABLE', message);
}
