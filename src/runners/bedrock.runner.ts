import { getLogger } from '../lib/logging';
import type { AgentRunner, RunOptions, RunResult, BedrockRunnerConfig } from './types';

const logger = getLogger('runner:bedrock');

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
      // Build the request body in Anthropic Messages API format (Bedrock's native format for Claude)
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: options.prompt }],
      });

      const credentials = await resolveAwsCredentials();
      const headers = await signRequest({
        method: 'POST',
        url,
        body,
        region: this.region,
        service: 'bedrock',
        credentials,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });

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

      const data = (await response.json()) as { id?: string };

      logger.info({ responseId: data.id }, 'Bedrock InvokeModel returned');
      return {
        status: 'ok',
        runId: data.id ?? `bedrock-${Date.now()}`,
        startedAt,
        endedAt,
        renderedPrompt: options.prompt,
      };
    } catch (error) {
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
      return {
        status: 'error',
        error: message,
        startedAt,
        endedAt,
        renderedPrompt: options.prompt,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AWS SigV4 signing (minimal implementation — no SDK dependency)
// ---------------------------------------------------------------------------

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

async function resolveAwsCredentials(): Promise<AwsCredentials> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }

  // Try IMDSv2 (EC2/ECS/Lambda instance metadata)
  try {
    const tokenResponse = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(2_000),
    });

    if (tokenResponse.ok) {
      const token = await tokenResponse.text();
      const roleResponse = await fetch(
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(2_000) },
      );

      if (roleResponse.ok) {
        const roleName = (await roleResponse.text()).trim();
        const credResponse = await fetch(
          `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
          { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(2_000) },
        );

        if (credResponse.ok) {
          const creds = (await credResponse.json()) as {
            AccessKeyId: string;
            SecretAccessKey: string;
            Token: string;
          };
          return {
            accessKeyId: creds.AccessKeyId,
            secretAccessKey: creds.SecretAccessKey,
            sessionToken: creds.Token,
          };
        }
      }
    }
  } catch {
    // IMDS not available — fall through
  }

  throw new Error(
    'No AWS credentials found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run on an instance with an IAM role.',
  );
}

async function signRequest(options: SignRequestOptions): Promise<Record<string, string>> {
  const { createHmac, createHash } = await import('node:crypto');
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

  const canonicalRequest = [
    method,
    parsedUrl.pathname,
    parsedUrl.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = [region, service, 'aws4_request'].reduce(
    (key, segment) => createHmac('sha256', key).update(segment).digest(),
    createHmac('sha256', `AWS4${credentials.secretAccessKey}`).update(dateStamp).digest(),
  );

  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}
