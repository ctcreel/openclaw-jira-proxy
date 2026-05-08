/**
 * Fetches full Gmail threads via the Gmail API using service account
 * domain-wide delegation. Used by thread enrichment to build richer
 * embedding queries for memory retrieval.
 */

import { createSign } from 'node:crypto';

import { getLogger } from '../../lib/logging';

const logger = getLogger('gmail-thread-fetcher');

const SA_KEY_ENV = 'GCP_SERVICE_ACCOUNT_KEY';

const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users';

interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
}

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function buildJwt(serviceAccount: ServiceAccountKey, subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      sub: subject,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = base64url(signer.sign(serviceAccount.private_key));

  return `${header}.${payload}.${signature}`;
}

async function getAccessToken(subject: string): Promise<string> {
  const keyJson = process.env[SA_KEY_ENV];
  if (!keyJson) {
    throw new Error(
      `${SA_KEY_ENV} env var not set — add gcp_service_account_key to SECRETS_CONFIG`,
    );
  }
  const serviceAccount = JSON.parse(keyJson) as ServiceAccountKey;
  const jwt = buildJwt(serviceAccount, subject);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

interface GmailMessage {
  readonly payload?: {
    readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    readonly body?: { readonly data?: string };
    readonly parts?: ReadonlyArray<{
      readonly mimeType: string;
      readonly body?: { readonly data?: string };
    }>;
  };
}

interface GmailThread {
  readonly messages?: readonly GmailMessage[];
}

function extractBody(message: GmailMessage): string {
  const payload = message.payload;
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  const textPart = payload.parts?.find((p) => p.mimeType === 'text/plain');
  if (textPart?.body?.data) {
    return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
  }

  return '';
}

export async function fetchGmailThread(
  account: string,
  threadId: string,
  maxMessages: number,
): Promise<readonly string[]> {
  const token = await getAccessToken(account);

  const url = `${GMAIL_BASE}/${encodeURIComponent(account)}/threads/${threadId}?format=full`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    logger.warn(
      { account, threadId, status: response.status, body: text },
      'Gmail thread fetch failed',
    );
    return [];
  }

  const thread = (await response.json()) as GmailThread;
  const messages = thread.messages ?? [];

  return messages
    .slice(-maxMessages)
    .map(extractBody)
    .filter((body) => body.length > 0);
}
