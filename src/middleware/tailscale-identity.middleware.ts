import type { NextFunction, Request, Response } from 'express';

import { getStringHeader } from '../lib/extract';
import { getLogger } from '../lib/logging';

const logger = getLogger('tailscale-identity');

/**
 * Tailscale's reverse proxy injects three headers on requests that
 * originate inside the tailnet (Tailscale Serve) — they are stripped
 * for anonymous/public requests, so when present they can be trusted
 * as long as the upstream server is bound to localhost or to the
 * tailnet interface.
 *
 *   - `Tailscale-User-Login`        — the user's email address.
 *   - `Tailscale-User-Name`         — display name.
 *   - `Tailscale-User-Profile-Pic`  — optional profile picture URL.
 *
 * Reference: https://tailscale.com/kb/1312/serve#identity-headers
 *
 * Two practical things this middleware does:
 *
 *   1. **Gate the editor-UI surface**: routes mounted behind this
 *      middleware return 401 when the headers are absent (failed
 *      closed — a request reaching the server without identity is by
 *      definition not from a tailnet user) and 403 when the identity
 *      is present but the email is not in the configured allowlist.
 *
 *   2. **Surface identity to downstream handlers** via
 *      `response.locals.tailscaleIdentity`. The PR-style write flow,
 *      audit log, and any future operator-action logging will read it
 *      from there rather than re-parsing the headers.
 *
 * Crucially, this middleware DOES NOT authenticate the request itself
 * — Tailscale does. It enforces presence + allowlist on the headers
 * Tailscale already validated. If clawndom is ever exposed without
 * Tailscale in front (raw 0.0.0.0 bind), this gate is meaningless —
 * an attacker can synthesize any header values. The deployment must
 * keep the listen address tailnet-only.
 */
export interface TailscaleIdentity {
  /** User's email address. The stable cross-device identifier. */
  readonly login: string;
  /** Display name (e.g. "Chris Creel"). */
  readonly name: string;
  /** Optional profile picture URL. */
  readonly profilePic?: string;
}

export interface TailscaleAuthConfig {
  /**
   * Allowlist of emails permitted past this gate. When `undefined`,
   * any tailnet user with valid Tailscale headers is allowed (header
   * presence is still required — anonymous requests are 401'd).
   * When set to an empty array, every authenticated user is 403'd —
   * useful as an emergency-stop knob.
   */
  readonly allowlist?: readonly string[];
}

export function createTailscaleIdentityMiddleware(config: TailscaleAuthConfig) {
  const allowlistSet =
    config.allowlist === undefined ? null : new Set(config.allowlist.map(normalizeEmail));

  return function checkTailscaleIdentity(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    const login = getStringHeader(request, 'tailscale-user-login');
    const name = getStringHeader(request, 'tailscale-user-name');

    if (login === undefined || login === '' || name === undefined || name === '') {
      logger.warn(
        { url: request.url, hasLogin: login !== undefined, hasName: name !== undefined },
        'Tailscale identity headers missing — rejecting request',
      );
      response.status(401).json({ error: 'Tailscale identity required' });
      return;
    }

    if (allowlistSet !== null && !allowlistSet.has(normalizeEmail(login))) {
      logger.warn({ url: request.url, login }, 'Tailscale user not in allowlist — rejecting');
      response.status(403).json({ error: `user ${login} is not permitted on this surface` });
      return;
    }

    const identity: TailscaleIdentity = {
      login,
      name,
      ...buildOptionalProfilePic(getStringHeader(request, 'tailscale-user-profile-pic')),
    };
    response.locals['tailscaleIdentity'] = identity;
    next();
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function buildOptionalProfilePic(value: string | undefined): { profilePic?: string } {
  if (value === undefined || value === '') return {};
  return { profilePic: value };
}

export function getTailscaleIdentity(response: Response): TailscaleIdentity | undefined {
  const value: unknown = response.locals['tailscaleIdentity'];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('login' in value) || !('name' in value)) return undefined;
  const login = value.login;
  const name = value.name;
  if (typeof login !== 'string' || typeof name !== 'string') return undefined;
  const profilePic = 'profilePic' in value ? value.profilePic : undefined;
  if (profilePic !== undefined && typeof profilePic !== 'string') return undefined;
  return profilePic === undefined ? { login, name } : { login, name, profilePic };
}
