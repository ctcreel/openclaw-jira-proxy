import { createHmac, createHash } from 'node:crypto';

import { z } from 'zod';

import { getLogger } from '../lib/logging';
import type { AgentRunner, RunOptions, RunResult, BedrockRunnerConfig } from './types';

const logger = getLogger('runner:bedrock');

const IMDS_BASE = 'http://169.254.169.254/latest';
const IMDS_TIMEOUT_MS = 2_000;

const ImdsCredentialsSchema = z.object({
  AccessKeyId: z.string(),
  SecretAccessKey: z.string(),
  Token: z.string(),
});

const BedrockResponseSchema = z
  .object({
    id: z.string().optional(),
  })
  .passthrough();

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SignRequestOptions {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
}

/**
 * Calls AWS Bedrock InvokeModel API using native fetch with SigV4 signing.
 * Uses ambient AWS credentials (IAM role, env vars, or ~/.aws/credentials).
 * No AWS SDK dependency — keeps the bundle small.
 */
export class BedrockRunner implements AgentRunner {
  readonly name = 'bedrock';
  private readonly modelId: string;
  private readonly region: string;

  constructor(config: BedrockRunnerConfig) {
    this.modelId = config.modelId;
    this.region = config.region;
  }

  isHealthy(): boolean {
    // Stateless HTTP — health depends on AWS credentials being available.
    // A full check would call STS, but that's too expensive for a health poll.
    return true;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const modelId = options.model ?? this.modelId;
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;

    logger.info({ modelId, region: this.region }, 'Calling Bedrock InvokeModel');

    try {
      const response = await invokeBedrockModel(url, this.region, options);
      return await interpretBedrockResponse(response, options, startedAt);
    } catch (error) {
      return buildErrorResult(error, options, startedAt);
    }
  }
}

function buildErrorResult(error: unknown, options: RunOptions, startedAt: string): RunResult {
  const endedAt = new Date().toISOString();
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return {
      status: 'timeout',
      error: `Bedrock request timed out after ${options.timeoutMs}ms`,
      startedAt,
      endedAt,
      renderedPrompt: options.prompt,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ error: message }, 'Bedrock request failed');
  return { status: 'error', error: message, startedAt, endedAt, renderedPrompt: options.prompt };
}

async function invokeBedrockModel(
  url: string,
  region: string,
  options: RunOptions,
): Promise<Response> {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content: options.prompt }],
  });
  const credentials = await resolveAwsCredentials();
  const headers = signRequest({
    method: 'POST',
    url,
    body,
    region,
    service: 'bedrock',
    credentials,
  });
  return fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

async function interpretBedrockResponse(
  response: Response,
  options: RunOptions,
  startedAt: string,
): Promise<RunResult> {
  const endedAt = new Date().toISOString();
  if (!response.ok) {
    const responseBody = await response.text();
    logger.error(
      { status: response.status, body: responseBody.slice(0, 500) },
      'Bedrock API error',
    );
    return {
      status: 'error',
      error: `Bedrock API returned ${response.status}: ${responseBody.slice(0, 200)}`,
      startedAt,
      endedAt,
      renderedPrompt: options.prompt,
    };
  }
  const data = BedrockResponseSchema.parse(await response.json());
  logger.info({ responseId: data.id }, 'Bedrock InvokeModel returned');
  return {
    status: 'ok',
    runId: data.id ?? `bedrock-${Date.now()}`,
    startedAt,
    endedAt,
    renderedPrompt: options.prompt,
  };
}

// ---------------------------------------------------------------------------
// AWS credentials
// ---------------------------------------------------------------------------

function resolveFromEnv(): AwsCredentials | null {
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env['AWS_SESSION_TOKEN'],
  };
}

async function resolveFromImdsV2(): Promise<AwsCredentials | null> {
  try {
    const tokenResponse = await fetch(`${IMDS_BASE}/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) return null;
    const token = await tokenResponse.text();
    const imdsHeaders = {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    };
    const roleResponse = await fetch(
      `${IMDS_BASE}/meta-data/iam/security-credentials/`,
      imdsHeaders,
    );
    if (!roleResponse.ok) return null;
    const roleName = (await roleResponse.text()).trim();
    const credResponse = await fetch(
      `${IMDS_BASE}/meta-data/iam/security-credentials/${roleName}`,
      imdsHeaders,
    );
    if (!credResponse.ok) return null;
    const creds = ImdsCredentialsSchema.parse(await credResponse.json());
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.Token,
    };
  } catch {
    return null;
  }
}

async function resolveAwsCredentials(): Promise<AwsCredentials> {
  const fromEnv = resolveFromEnv();
  if (fromEnv) return fromEnv;

  const fromImds = await resolveFromImdsV2();
  if (fromImds) return fromImds;

  throw new Error(
    'No AWS credentials found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run on an instance with an IAM role.',
  );
}

// ---------------------------------------------------------------------------
// AWS SigV4 signing (minimal implementation — no SDK dependency)
// ---------------------------------------------------------------------------

function computeSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  return [region, service, 'aws4_request'].reduce(
    (key, segment) => createHmac('sha256', key).update(segment).digest(),
    createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest(),
  );
}

function buildCanonicalRequest(
  method: string,
  parsedUrl: URL,
  canonicalHeaders: string,
  signedHeaders: string,
  payloadHash: string,
): string {
  return [
    method,
    parsedUrl.pathname,
    parsedUrl.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
}

function signRequest(options: SignRequestOptions): Record<string, string> {
  const { method, url, body, region, service, credentials } = options;
  const parsedUrl = new URL(url);
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const payloadHash = createHash('sha256').update(body).digest('hex');

  const headers: Record<string, string> = {
    host: parsedUrl.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys.map((key) => `${key}:${headers[key]!}\n`).join('');
  const canonicalRequest = buildCanonicalRequest(
    method,
    parsedUrl,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  );

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = computeSigningKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}
