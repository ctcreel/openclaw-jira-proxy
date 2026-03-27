import type { Response } from 'express';

import { Sc0redError } from './base';

interface ErrorResponseBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  context?: Record<string, unknown>;
}

export function createErrorResponse(
  exception: Sc0redError,
  response: Response,
  options?: {
    includeContext?: boolean;
    requestId?: string;
  },
): void {
  const includeContext = options?.includeContext ?? true;

  const body: ErrorResponseBody = {
    type: `https://sc0red.ai/errors/${exception.errorCode}`,
    title: formatErrorTitle(exception.errorCode),
    status: exception.httpStatus,
    detail: exception.message,
  };

  if (options?.requestId) {
    body.instance = `/requests/${options.requestId}`;
  }

  if (includeContext && Object.keys(exception.context).length > 0) {
    body.context = exception.context;
  }

  response.status(exception.httpStatus).set('Content-Type', 'application/problem+json').json(body);
}

export function createSuccessResponse(
  response: Response,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.status(statusCode).json(body);
}

function formatErrorTitle(errorCode: string): string {
  return errorCode
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function getHttpStatusForErrorCode(errorCode: string): number {
  const errorClass = Sc0redError.getByErrorCode(errorCode);
  if (errorClass) {
    return (errorClass as unknown as typeof Sc0redError).httpStatus;
  }
  return 500;
}
