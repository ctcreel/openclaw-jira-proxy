import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookProviderConfig } from '../config';

import { oidcStrategy } from './oidc';

export interface SignatureStrategy {
  readonly headerName: string;
  /** Additional headers required for validation (e.g., Slack needs the timestamp header). */
  readonly additionalHeaders?: readonly string[];
  /**
   * Validate the inbound request. Return type allows async strategies (OIDC
   * has to fetch + cache Google's JWKs); sync strategies just return `boolean`.
   * The optional `provider` argument lets strategies that need richer config
   * than a single secret (OIDC needs an expected audience) read it from the
   * provider definition.
   */
  validate(
    rawBody: Buffer,
    signatureHeader: string,
    secret: string,
    headers?: Record<string, string>,
    provider?: WebhookProviderConfig,
  ): boolean | Promise<boolean>;
}

function validateHmacSha256(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const receivedHex = signatureHeader.slice(expectedPrefix.length);
  const computedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  const receivedBuffer = Buffer.from(receivedHex, 'hex');
  const computedBuffer = Buffer.from(computedHex, 'hex');

  if (receivedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, computedBuffer);
}

/**
 * WebSub format used by Jira Cloud.
 * Header: X-Hub-Signature
 * Value: sha256=<hex>
 */
export const websubStrategy: SignatureStrategy = {
  headerName: 'x-hub-signature',
  validate: validateHmacSha256,
};

/**
 * GitHub webhook format.
 * Header: X-Hub-Signature-256
 * Value: sha256=<hex>
 */
export const githubStrategy: SignatureStrategy = {
  headerName: 'x-hub-signature-256',
  validate: validateHmacSha256,
};

/**
 * Bearer token strategy for Google Pub/Sub push endpoints.
 * Header: Authorization
 * Value: Bearer <token>
 *
 * For Google Pub/Sub, the token is a JWT signed by Google.
 * This strategy validates the token matches the expected value.
 * For full JWT verification, pass a verify function via bearerStrategy().
 */
export const bearerStrategy: SignatureStrategy = {
  headerName: 'authorization',
  validate(_rawBody: Buffer, authHeader: string, secret: string): boolean {
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) {
      return false;
    }
    const token = authHeader.slice(prefix.length);

    // Timing-safe comparison of the bearer token against the shared secret
    const tokenBuffer = Buffer.from(token, 'utf-8');
    const secretBuffer = Buffer.from(secret, 'utf-8');

    if (tokenBuffer.length !== secretBuffer.length) {
      return false;
    }

    return timingSafeEqual(tokenBuffer, secretBuffer);
  },
};

const SLACK_TIMESTAMP_MAX_AGE_SECONDS = 300;

/**
 * Slack Events API signature verification.
 * Header: x-slack-signature
 * Value: v0={hex}
 * Basestring: v0:{timestamp}:{rawBody}
 * Also requires x-slack-request-timestamp header for replay protection.
 */
export const slackStrategy: SignatureStrategy = {
  headerName: 'x-slack-signature',
  additionalHeaders: ['x-slack-request-timestamp'] as const,
  validate(
    rawBody: Buffer,
    signatureHeader: string,
    secret: string,
    headers?: Record<string, string>,
  ): boolean {
    const prefix = 'v0=';
    if (!signatureHeader.startsWith(prefix)) {
      return false;
    }

    const timestamp = headers?.['x-slack-request-timestamp'];
    if (!timestamp) {
      return false;
    }

    const timestampSeconds = Number(timestamp);
    if (Number.isNaN(timestampSeconds)) {
      return false;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > SLACK_TIMESTAMP_MAX_AGE_SECONDS) {
      return false;
    }

    const basestring = `v0:${timestamp}:${rawBody.toString('utf-8')}`;
    const computedHex = createHmac('sha256', secret).update(basestring).digest('hex');
    const expectedSignature = `v0=${computedHex}`;

    const receivedBuffer = Buffer.from(signatureHeader, 'utf-8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(receivedBuffer, expectedBuffer);
  },
};

const strategies: Record<string, SignatureStrategy> = {
  websub: websubStrategy,
  github: githubStrategy,
  bearer: bearerStrategy,
  slack: slackStrategy,
  oidc: oidcStrategy,
};

export function getSignatureStrategy(name: string): SignatureStrategy {
  const strategy = strategies[name];
  if (!strategy) {
    throw new Error(
      `Unknown signature strategy: ${name}. Valid strategies: ${Object.keys(strategies).join(', ')}`,
    );
  }
  return strategy;
}
