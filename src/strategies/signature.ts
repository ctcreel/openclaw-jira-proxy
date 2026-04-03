import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureStrategy {
  readonly headerName: string;
  validate(rawBody: Buffer, signatureHeader: string, secret: string): boolean;
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

const strategies: Record<string, SignatureStrategy> = {
  websub: websubStrategy,
  github: githubStrategy,
  bearer: bearerStrategy,
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
