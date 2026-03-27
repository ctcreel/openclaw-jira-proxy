import { setCorrelationId, setExtraContext } from '../context';

export interface LambdaContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: number;
  invokedFunctionArn: string;
  logGroupName: string;
  logStreamName: string;
}

export function setLambdaContext(
  event: Record<string, unknown>,
  context: LambdaContext,
  options?: { extractUserId?: boolean },
): void {
  const extractUserId = options?.extractUserId ?? true;

  setCorrelationId(context.awsRequestId);

  const extra: Record<string, unknown> = {
    functionName: context.functionName,
    functionVersion: context.functionVersion,
  };

  const requestContext = event.requestContext as Record<string, unknown> | undefined;
  if (requestContext) {
    const apiRequestId = requestContext.requestId;
    if (typeof apiRequestId === 'string') {
      extra.apiRequestId = apiRequestId;
    }

    const httpMethod = event.httpMethod;
    if (typeof httpMethod === 'string') {
      extra.httpMethod = httpMethod;
    }

    const path = event.path;
    if (typeof path === 'string') {
      extra.path = path;
    }

    if (extractUserId) {
      const authorizer = requestContext.authorizer as Record<string, unknown> | undefined;
      if (authorizer) {
        const claims = authorizer.claims as Record<string, unknown> | undefined;
        const userId = claims?.sub ?? authorizer.principalId;
        if (typeof userId === 'string') {
          extra.userId = userId;
        }
      }
    }
  }

  setExtraContext(extra);
}

export function setLambdaContextMinimal(context: LambdaContext): void {
  setCorrelationId(context.awsRequestId);
  setExtraContext({
    functionName: context.functionName,
    functionVersion: context.functionVersion,
  });
}

export function getTraceIdFromHeader(event: Record<string, unknown>): string | null {
  const rawHeaders = event.headers as Record<string, string> | undefined;
  if (!rawHeaders) {
    return null;
  }

  const headersLower: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    headersLower[key.toLowerCase()] = value;
  }

  const traceHeaders = ['x-amzn-trace-id', 'x-request-id', 'x-correlation-id'];
  for (const header of traceHeaders) {
    const traceId = headersLower[header];
    if (traceId) {
      return traceId;
    }
  }

  return null;
}
