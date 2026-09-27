export class ClassesError extends Error {
  readonly status: number = 500;
  readonly code: string = 'INTERNAL_ERROR';
}

export class ClassesAccessError extends ClassesError {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  constructor(message = 'Class management access is required') {
    super(message);
    this.name = 'ClassesAccessError';
  }
}

export class ClassesNotFoundError extends ClassesError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
  constructor(message = 'Class record was not found') {
    super(message);
    this.name = 'ClassesNotFoundError';
  }
}

export class ClassesConflictError extends ClassesError {
  readonly status = 409;
  readonly code = 'CONFLICT';
  constructor(
    message: string,
    readonly detailCode?: string,
  ) {
    super(message);
    this.name = 'ClassesConflictError';
  }
}

export class OfferingFullError extends ClassesError {
  readonly status = 409;
  readonly code = 'CLASS_OFFERING_FULL';
  constructor() {
    super('This class is full');
    this.name = 'OfferingFullError';
  }
}

export class AgeIneligibleError extends ClassesError {
  readonly status = 409;
  readonly code = 'CLASS_AGE_INELIGIBLE';
  constructor() {
    super('The athlete is outside this class’s age range');
    this.name = 'AgeIneligibleError';
  }
}

export class SessionFullError extends ClassesError {
  readonly status = 409;
  readonly code = 'CLASS_SESSION_FULL';
  constructor() {
    super('This session has no spots left');
    this.name = 'SessionFullError';
  }
}

export class MakeupCreditError extends ClassesError {
  readonly status = 409;
  readonly code = 'MAKEUP_CREDIT_UNAVAILABLE';
  constructor(message = 'The make-up credit is not available') {
    super(message);
    this.name = 'MakeupCreditError';
  }
}
