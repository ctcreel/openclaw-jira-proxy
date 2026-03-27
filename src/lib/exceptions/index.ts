export { registerError, Sc0redError } from './base';
export {
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ClientError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from './client-errors';
export { createErrorResponse, createSuccessResponse, getHttpStatusForErrorCode } from './handlers';
export {
  ConfigurationError,
  DatabaseError,
  ExternalServiceError,
  OperationTimeoutError,
  ProcessingError,
  ServerError,
  ServiceUnavailableError,
} from './server-errors';
