import { generateKeyPairSync, createSign } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfig } from '../../src/config';
import { __testing, oidcStrategy, verifyOidcToken } from '../../src/strategies/oidc';

const TEST_KID = 'test-kid-001';
const AUDIENCE = 'https://winston-agent.example.test/hooks/gmail-pubsub';
const ISSUER = 'https://accounts.google.com';
const SA_EMAIL = 'winston@talk-winston-ai.iam.gserviceaccount.com';

interface KeyPair {
  privateKeyPem: string;
  jwk: Record<string, unknown>;
}

function generateKey(kid: string = TEST_KID): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk['kid'] = kid;
  jwk['alg'] = 'RS256';
  jwk['use'] = 'sig';
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { privateKeyPem, jwk };
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  const base = buf.toString('base64');
  const trimmed = base.endsWith('==')
    ? base.slice(0, -2)
    : base.endsWith('=')
      ? base.slice(0, -1)
      : base;
  return trimmed.replaceAll('+', '-').replaceAll('/', '_');
}

interface MintOptions {
  privateKeyPem: string;
  kid?: string;
  alg?: string;
  iss?: string;
  aud?: string | readonly string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  email?: string;
}

function mintJwt(opts: MintOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? TEST_KID };
  const payload: Record<string, unknown> = {
    iss: opts.iss ?? ISSUER,
    aud: opts.aud ?? AUDIENCE,
    exp: opts.exp ?? now + 600,
    iat: opts.iat ?? now,
    email: opts.email ?? SA_EMAIL,
  };
  if (opts.nbf !== undefined) payload['nbf'] = opts.nbf;
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signedInput = `${headerB64}.${payloadB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signedInput);
  signer.end();
  const signature = signer.sign(opts.privateKeyPem);
  return `${signedInput}.${b64url(signature)}`;
}

function primeJwks(kid: string, jwk: Record<string, unknown>, uri: string): void {
  __testing.setCache({
    keys: new Map([[kid, jwk as never]]),
    fetchedAt: Date.now(),
    uri,
  });
}

function makeOidcProvider(overrides: Record<string, unknown> = {}): ProviderConfig {
  return {
    name: 'gmail-pubsub',
    transport: 'webhook',
    routePath: '/hooks/gmail-pubsub',
    signatureStrategy: 'oidc',
    oidc: {
      audience: AUDIENCE,
      jwksUri: 'https://test-jwks.example.test/keys',
      ...(overrides['oidc'] as Record<string, unknown> | undefined),
    },
    ...overrides,
  } as ProviderConfig;
}

describe('oidcStrategy', () => {
  let keyPair: KeyPair;
  const jwksUri = 'https://test-jwks.example.test/keys';

  beforeEach(() => {
    keyPair = generateKey();
    primeJwks(TEST_KID, keyPair.jwk, jwksUri);
  });

  afterEach(() => {
    __testing.resetCache();
    vi.restoreAllMocks();
  });

  it('accepts a valid Pub/Sub-style JWT', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(true);
  });

  it('rejects a token with an audience mismatch', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem, aud: 'https://wrong.example/' });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('rejects a token with an unknown issuer', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem, iss: 'https://evil.example' });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintJwt({
      privateKeyPem: keyPair.privateKeyPem,
      exp: now - 3600,
      iat: now - 7200,
    });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('rejects a token signed with a different key (signature failure)', async () => {
    const attacker = generateKey('attacker-kid');
    primeJwks(TEST_KID, keyPair.jwk, jwksUri);
    const jwt = mintJwt({ privateKeyPem: attacker.privateKeyPem });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('rejects when the Authorization header is missing the Bearer prefix', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Basic ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('rejects when the JWT header alg is not RS256', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem, alg: 'HS256' });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('rejects when provider.oidc is missing', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem });
    const provider = {
      name: 'gmail-pubsub',
      transport: 'webhook',
      routePath: '/hooks/gmail-pubsub',
      signatureStrategy: 'oidc',
    } as unknown as ProviderConfig;
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      provider,
    );
    expect(ok).toBe(false);
  });

  it('rejects a malformed JWT', async () => {
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      'Bearer not-a-jwt',
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(false);
  });

  it('enforces serviceAccountEmail when configured', async () => {
    const jwt = mintJwt({
      privateKeyPem: keyPair.privateKeyPem,
      email: 'someone-else@example.iam.gserviceaccount.com',
    });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider({ oidc: { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL, jwksUri } }),
    );
    expect(ok).toBe(false);
  });

  it('accepts the matching serviceAccountEmail when configured', async () => {
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider({ oidc: { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL, jwksUri } }),
    );
    expect(ok).toBe(true);
  });

  it('re-fetches JWKs when the kid is unknown (key rotation)', async () => {
    const fresh = generateKey('rotated-kid');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ keys: [fresh.jwk] }), { status: 200 }));
    __testing.setCache({
      keys: new Map([[TEST_KID, keyPair.jwk as never]]),
      fetchedAt: Date.now(),
      uri: jwksUri,
    });
    const jwt = mintJwt({ privateKeyPem: fresh.privateKeyPem, kid: 'rotated-kid' });
    const ok = await oidcStrategy.validate(
      Buffer.from('{}'),
      `Bearer ${jwt}`,
      '',
      undefined,
      makeOidcProvider(),
    );
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects when JWKS fetch fails on a cache miss', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    __testing.resetCache();
    const jwt = mintJwt({ privateKeyPem: keyPair.privateKeyPem });
    const ok = await verifyOidcToken(jwt, {
      audience: AUDIENCE,
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      jwksUri,
    });
    expect(ok).toBe(false);
  });
});
