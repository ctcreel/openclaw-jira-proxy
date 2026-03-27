import { registerError, Sc0redError } from './base';

export class ClientError extends Sc0redError {
  static override readonly errorCode: string = 'CLIENT_ERROR';
  static override readonly httpStatus: number = 400;
}
registerError(ClientError);

export class ValidationError extends ClientError {
  static override readonly errorCode = 'VALIDATION_ERROR';
  static override readonly httpStatus = 400;

  constructor(
    message: string,
    options?: {
      field?: string;
      value?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    const context: Record<string, unknown> = { ...options?.context };
    if (options?.field !== undefined) {
      context.field = options.field;
    }
    if (options?.value !== undefined) {
      context.value = options.value;
    }
    super(message, { context });
  }
}
registerError(ValidationError);

export class NotFoundError extends ClientError {
  static override readonly errorCode = 'NOT_FOUND';
  static override readonly httpStatus = 404;

  constructor(
    message: string,
    options?: {
      resourceType?: string;
      resourceId?: string;
      context?: Record<string, unknown>;
    },
  ) {
    const context: Record<string, unknown> = { ...options?.context };
    if (options?.resourceType !== undefined) {
      context.resourceType = options.resourceType;
    }
    if (options?.resourceId !== undefined) {
      context.resourceId = options.resourceId;
    }
    super(message, { context });
  }
}
registerError(NotFoundError);

export class ConflictError extends ClientError {
  static override readonly errorCode = 'CONFLICT';
  static override readonly httpStatus = 409;
}
registerError(ConflictError);

export class AuthenticationError extends ClientError {
  static override readonly errorCode = 'AUTHENTICATION_FAILED';
  static override readonly httpStatus = 401;
}
registerError(AuthenticationError);

export class AuthorizationError extends ClientError {
  static override readonly errorCode = 'AUTHORIZATION_FAILED';
  static override readonly httpStatus = 403;
}
registerError(AuthorizationError);

export class RateLimitError extends ClientError {
  static override readonly errorCode = 'RATE_LIMIT_EXCEEDED';
  static override readonly httpStatus = 429;
}
registerError(RateLimitError);

export class BadRequestError extends ClientError {
  static override readonly errorCode = 'BAD_REQUEST';
  static override readonly httpStatus = 400;
}
registerError(BadRequestError);
