import { z } from 'zod';

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

/**
 * Schema for the parts of the API Gateway Lambda event we care about for
 * logging. Everything is optional because Clawndom also accepts non-API
 * Gateway invocations (direct invokes, SQS, scheduled events), and the
 * adapter must degrade to "no extra context" rather than throw on those.
 */
const LambdaEventSchema = z
  .object({
    requestContext: z
      .object({
        requestId: z.string().optional(),
        authorizer: z
          .object({
            claims: z
              .object({
                sub: z.string().optional(),
              })
              .passthrough()
              .optional(),
            principalId: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    httpMethod: z.string().optional(),
    path: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type ParsedLambdaEvent = z.infer<typeof LambdaEventSchema>;

function resolveUserId(parsedEvent: ParsedLambdaEvent): string | undefined {
  const authorizer = parsedEvent.requestContext?.authorizer;
  if (!authorizer) return undefined;
  return authorizer.claims?.sub ?? authorizer.principalId;
}

export function setLambdaContext(
  event: Record<string, unknown>,
  context: LambdaContext,
  options?: { extractUserId?: boolean },
): void {
  const extractUserId = options?.extractUserId ?? true;
  setCorrelationId(context.awsRequestId);

  const parsedEvent = LambdaEventSchema.parse(event);
  const extra: Record<string, unknown> = {
    functionName: context.functionName,
    functionVersion: context.functionVersion,
  };

  const apiRequestId = parsedEvent.requestContext?.requestId;
  if (apiRequestId) extra.apiRequestId = apiRequestId;

  if (parsedEvent.httpMethod) extra.httpMethod = parsedEvent.httpMethod;
  if (parsedEvent.path) extra.path = parsedEvent.path;

  if (extractUserId) {
    const userId = resolveUserId(parsedEvent);
    if (userId) extra.userId = userId;
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
  const parsedEvent = LambdaEventSchema.parse(event);
  if (!parsedEvent.headers) return null;

  const headersLower: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedEvent.headers)) {
    headersLower[key.toLowerCase()] = value;
  }

  const traceHeaders = ['x-amzn-trace-id', 'x-request-id', 'x-correlation-id'];
  for (const header of traceHeaders) {
    const traceId = headersLower[header];
    if (traceId) return traceId;
  }
  return null;
}
