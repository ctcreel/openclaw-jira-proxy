import { isPlainObject } from '../../lib/extract';

import type { IdentityHints } from './resolver-strategy';

export type SurfaceKind = 'slack' | 'gmail' | 'http' | 'unknown';

export function extractIdentityHints(surface: SurfaceKind, payload: unknown): IdentityHints {
  if (!isPlainObject(payload)) return {};
  switch (surface) {
    case 'slack':
      return extractSlackHints(payload);
    case 'gmail':
      return extractGmailHints(payload);
    case 'http':
      return extractHttpHints(payload);
    default:
      return {};
  }
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function extractSlackHints(payload: Record<string, unknown>): IdentityHints {
  const hints: IdentityHints = {};
  const event = payload['event'];
  if (isPlainObject(event)) {
    const user = readStringField(event, 'user');
    if (user !== undefined) hints.slack_user_id = user;
  }
  const directUser = readStringField(payload, 'user');
  if (directUser !== undefined && hints.slack_user_id === undefined) {
    hints.slack_user_id = directUser;
  }
  return hints;
}

function extractGmailHints(payload: Record<string, unknown>): IdentityHints {
  const hints: IdentityHints = {};
  const fromEmail =
    readEmailLikeField(payload, 'from') ??
    readEmailLikeField(payload, 'fromEmail') ??
    readEmailLikeField(payload, 'sender');
  if (fromEmail !== undefined) hints.email = fromEmail;
  return hints;
}

function extractHttpHints(payload: Record<string, unknown>): IdentityHints {
  const hints: IdentityHints = {};
  const dispatching = readStringField(payload, 'dispatching_actor_email');
  if (dispatching !== undefined) hints.email = dispatching;
  const oidcEmail = readStringField(payload, 'oidc_email');
  if (oidcEmail !== undefined) hints.oidc_email = oidcEmail;
  return hints;
}

function readEmailLikeField(payload: Record<string, unknown>, field: string): string | undefined {
  const raw = readStringField(payload, field);
  if (raw === undefined) return undefined;
  const match = raw.match(/<([^>]+)>/);
  if (match !== null && match[1] !== undefined) {
    return match[1];
  }
  if (raw.includes('@')) {
    return raw.trim();
  }
  return undefined;
}
