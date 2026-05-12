import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

import type { WebhookProviderConfig } from '../config';
import { getLogger } from '../lib/logging';

import type { SignatureStrategy } from './signature';

const logger = getLogger('oidc-strategy');

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_DEFAULT_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 60;

interface CachedJwks {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
  uri: string;
}

let cache: CachedJwks | null = null;
let inFlight: Promise<CachedJwks> | null = null;

interface JwtParts {
  header: { alg?: string; kid?: string; typ?: string };
  payload: {
    iss?: string;
    aud?: string | readonly string[];
    exp?: number;
    iat?: number;
    nbf?: number;
    email?: string;
  };
  signedInput: Buffer;
  signature: Buffer;
}

function decodeBase64Url(input: string): Buffer {
  const swapped = input.replaceAll('-', '+').replaceAll('_', '/');
  const padded = swapped.padEnd(swapped.length + ((4 - (swapped.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function parseJwt(token: string): JwtParts | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const signatureB64 = parts[2];
  if (!headerB64 || !payloadB64 || !signatureB64) return null;
  try {
    const header = JSON.parse(decodeBase64Url(headerB64).toString('utf-8'));
    const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf-8'));
    const signature = decodeBase64Url(signatureB64);
    const signedInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
    return { header, payload, signedInput, signature };
  } catch {
    return null;
  }
}

async function fetchJwks(uri: string): Promise<CachedJwks> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(uri, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`JWKS fetch ${uri} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { keys?: JsonWebKey[] };
    const keys = new Map<string, JsonWebKey>();
    for (const key of body.keys ?? []) {
      const kid = (key as { kid?: string }).kid;
      if (typeof kid === 'string') {
        keys.set(kid, key);
      }
    }
    if (keys.size === 0) {
      throw new Error(`JWKS at ${uri} returned no usable keys`);
    }
    return { keys, fetchedAt: Date.now(), uri };
  } finally {
    clearTimeout(timer);
  }
}

async function getJwks(uri: string): Promise<CachedJwks> {
  const now = Date.now();
  if (cache && cache.uri === uri && now - cache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cache;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = fetchJwks(uri)
    .then((fresh) => {
      cache = fresh;
      return fresh;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function verifySignature(parts: JwtParts, jwk: JsonWebKey): boolean {
  try {
    const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(parts.signedInput);
    verifier.end();
    return verifier.verify(publicKey, parts.signature);
  } catch (error) {
    logger.debug({ error: (error as Error).message }, 'JWK signature verification threw');
    return false;
  }
}

function compareTimingSafe(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function checkAudience(claim: JwtParts['payload']['aud'], expected: string): boolean {
  if (typeof claim === 'string') return compareTimingSafe(claim, expected);
  if (Array.isArray(claim))
    return claim.some((v) => typeof v === 'string' && compareTimingSafe(v, expected));
  return false;
}

interface OidcConfig {
  audience: string;
  issuers: readonly string[];
  serviceAccountEmail?: string;
  jwksUri: string;
}

function resolveConfig(provider: WebhookProviderConfig): OidcConfig | null {
  if (provider.transport !== 'webhook') return null;
  if (!provider.oidc) return null;
  return {
    audience: provider.oidc.audience,
    issuers: provider.oidc.issuers ?? GOOGLE_DEFAULT_ISSUERS,
    serviceAccountEmail: provider.oidc.serviceAccountEmail,
    jwksUri: provider.oidc.jwksUri ?? GOOGLE_JWKS_URI,
  };
}

export async function verifyOidcToken(token: string, config: OidcConfig): Promise<boolean> {
  const parts = parseJwt(token);
  if (!parts) {
    logger.warn('OIDC token is not a well-formed JWT');
    return false;
  }
  if (parts.header.alg !== 'RS256') {
    logger.warn({ alg: parts.header.alg }, 'OIDC token uses unsupported signing algorithm');
    return false;
  }
  if (!parts.header.kid) {
    logger.warn('OIDC token header is missing kid claim');
    return false;
  }

  let jwks: CachedJwks;
  try {
    jwks = await getJwks(config.jwksUri);
  } catch (error) {
    logger.error(
      { error: (error as Error).message, uri: config.jwksUri },
      'JWKS fetch failed; rejecting',
    );
    return false;
  }

  let jwk = jwks.keys.get(parts.header.kid);
  if (!jwk) {
    cache = null;
    try {
      jwks = await getJwks(config.jwksUri);
      jwk = jwks.keys.get(parts.header.kid);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'JWKS refetch on kid miss failed');
      return false;
    }
  }
  if (!jwk) {
    logger.warn({ kid: parts.header.kid }, 'OIDC token kid not present in JWKS');
    return false;
  }

  if (!verifySignature(parts, jwk)) {
    logger.warn('OIDC token signature verification failed');
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof parts.payload.exp !== 'number' || parts.payload.exp + CLOCK_SKEW_SECONDS < now) {
    logger.warn({ exp: parts.payload.exp, now }, 'OIDC token is expired or missing exp');
    return false;
  }
  if (typeof parts.payload.nbf === 'number' && parts.payload.nbf - CLOCK_SKEW_SECONDS > now) {
    logger.warn({ nbf: parts.payload.nbf, now }, 'OIDC token nbf is in the future');
    return false;
  }
  if (typeof parts.payload.iat === 'number' && parts.payload.iat - CLOCK_SKEW_SECONDS > now) {
    logger.warn({ iat: parts.payload.iat, now }, 'OIDC token iat is in the future');
    return false;
  }

  if (typeof parts.payload.iss !== 'string' || !config.issuers.includes(parts.payload.iss)) {
    logger.warn({ iss: parts.payload.iss }, 'OIDC token issuer not in allowed list');
    return false;
  }

  if (!checkAudience(parts.payload.aud, config.audience)) {
    logger.warn({ aud: parts.payload.aud }, 'OIDC token audience does not match');
    return false;
  }

  if (config.serviceAccountEmail) {
    if (
      typeof parts.payload.email !== 'string' ||
      !compareTimingSafe(parts.payload.email, config.serviceAccountEmail)
    ) {
      logger.warn({ email: parts.payload.email }, 'OIDC token email does not match expected SA');
      return false;
    }
  }

  return true;
}

/**
 * Google Cloud Pub/Sub push OIDC authentication.
 *
 * The push subscription is configured with `oidcToken.audience = <full URL>`;
 * Pub/Sub signs a fresh RS256 JWT per push using Google's managed keys. We
 * fetch the signing keys from Google's JWKS endpoint (cached 1h), verify the
 * signature, then check issuer / audience / expiry / optional SA email.
 *
 * Use this strategy when ingesting Pub/Sub push notifications directly into
 * a Clawndom webhook (no relay service). It avoids the long-lived shared
 * secret model of the bearer strategy.
 */
export const oidcStrategy: SignatureStrategy = {
  headerName: 'authorization',
  async validate(
    _rawBody: Buffer,
    authHeader: string,
    _secret: string,
    _headers?: Record<string, string>,
    provider?: WebhookProviderConfig,
  ): Promise<boolean> {
    if (!provider) {
      logger.error('OIDC strategy was invoked without a provider config; rejecting');
      return false;
    }
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) {
      logger.warn('OIDC authorization header is missing Bearer prefix');
      return false;
    }
    const token = authHeader.slice(prefix.length).trim();
    if (!token) return false;

    const config = resolveConfig(provider);
    if (!config) {
      logger.error(
        { provider: provider.name },
        'OIDC strategy selected but provider.oidc is unset',
      );
      return false;
    }

    return verifyOidcToken(token, config);
  },
};

export const __testing = {
  resetCache: (): void => {
    cache = null;
    inFlight = null;
  },
  setCache: (next: CachedJwks | null): void => {
    cache = next;
  },
  getCache: (): CachedJwks | null => cache,
};
