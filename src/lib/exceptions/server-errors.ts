import { registerError, Sc0redError } from './base';

export class ServerError extends Sc0redError {
  static override readonly errorCode: string = 'SERVER_ERROR';
  static override readonly httpStatus: number = 500;
}
registerError(ServerError);

export class ProcessingError extends ServerError {
  static override readonly errorCode = 'PROCESSING_ERROR';
  static override readonly httpStatus = 500;
}
registerError(ProcessingError);

export class ExternalServiceError extends ServerError {
  static override readonly errorCode = 'EXTERNAL_SERVICE_ERROR';
  static override readonly httpStatus = 502;

  constructor(
    message: string,
    options?: {
      serviceName?: string;
      context?: Record<string, unknown>;
    },
  ) {
    const context: Record<string, unknown> = { ...options?.context };
    if (options?.serviceName !== undefined) {
      context.serviceName = options.serviceName;
    }
    super(message, { context });
  }
}
registerError(ExternalServiceError);

export class DatabaseError extends ServerError {
  static override readonly errorCode = 'DATABASE_ERROR';
  static override readonly httpStatus = 500;
}
registerError(DatabaseError);

export class ConfigurationError extends ServerError {
  static override readonly errorCode = 'CONFIGURATION_ERROR';
  static override readonly httpStatus = 500;
}
registerError(ConfigurationError);

export class ServiceUnavailableError extends ServerError {
  static override readonly errorCode = 'SERVICE_UNAVAILABLE';
  static override readonly httpStatus = 503;
}
registerError(ServiceUnavailableError);

export class OperationTimeoutError extends ServerError {
  static override readonly errorCode = 'TIMEOUT';
  static override readonly httpStatus = 504;
}
registerError(OperationTimeoutError);
