import { describe, it, expect } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import type { TailscaleAuthConfig } from '../../src/middleware/tailscale-identity.middleware';
import {
  createTailscaleIdentityMiddleware,
  getTailscaleIdentity,
} from '../../src/middleware/tailscale-identity.middleware';

interface MockResponse {
  statusCode: number;
  jsonBody: unknown;
  locals: Record<string, unknown>;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

interface MiddlewareRun {
  response: MockResponse;
  nextCalled: boolean;
}

function buildRequest(headers: Record<string, string>): Request {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    url: '/api/workspace/winston',
    headers: lowered,
  } as unknown as Request;
}

function buildResponse(): MockResponse {
  const mock: MockResponse = {
    statusCode: 0,
    jsonBody: undefined,
    locals: {},
    status(code: number): MockResponse {
      mock.statusCode = code;
      return mock;
    },
    json(body: unknown): MockResponse {
      mock.jsonBody = body;
      return mock;
    },
  };
  return mock;
}

/**
 * Shared one-shot for "build request, run middleware, return what
 * happened." Every test in this file does some variant of this, so
 * factoring it out keeps the assertions focused on the case being
 * exercised — and avoids the boilerplate Sonar flags as duplication.
 */
function runMiddleware(
  config: TailscaleAuthConfig,
  headers: Record<string, string>,
): MiddlewareRun {
  const state = { nextCalled: false };
  const next: NextFunction = () => {
    state.nextCalled = true;
  };
  const response = buildResponse();
  const middleware = createTailscaleIdentityMiddleware(config);
  middleware(buildRequest(headers), response as unknown as Response, next);
  return {
    response,
    get nextCalled(): boolean {
      return state.nextCalled;
    },
  };
}

const VALID_HEADERS = {
  'tailscale-user-login': 'chris@sc0red.com',
  'tailscale-user-name': 'Chris Creel',
};

describe('tailscale-identity middleware', () => {
  describe('without an allowlist (any tailnet user allowed)', () => {
    it('passes through when both required headers are present', () => {
      const run = runMiddleware({}, VALID_HEADERS);
      expect(run.nextCalled).toBe(true);
      expect(run.response.statusCode).toBe(0);
      expect(run.response.locals['tailscaleIdentity']).toEqual({
        login: 'chris@sc0red.com',
        name: 'Chris Creel',
      });
    });

    it('captures the optional profile-pic header when present', () => {
      const run = runMiddleware(
        {},
        {
          ...VALID_HEADERS,
          'tailscale-user-profile-pic': 'https://example.com/me.png',
        },
      );
      expect(run.nextCalled).toBe(true);
      expect(run.response.locals['tailscaleIdentity']).toEqual({
        login: 'chris@sc0red.com',
        name: 'Chris Creel',
        profilePic: 'https://example.com/me.png',
      });
    });

    it('rejects with 401 when both identity headers are missing (anonymous)', () => {
      const run = runMiddleware({}, {});
      expect(run.nextCalled).toBe(false);
      expect(run.response.statusCode).toBe(401);
      expect(run.response.jsonBody).toEqual({ error: 'Tailscale identity required' });
    });

    it('rejects with 401 when login is present but name is missing', () => {
      const run = runMiddleware({}, { 'tailscale-user-login': 'chris@sc0red.com' });
      expect(run.response.statusCode).toBe(401);
      expect(run.nextCalled).toBe(false);
    });

    it('rejects with 401 when name is present but login is missing', () => {
      const run = runMiddleware({}, { 'tailscale-user-name': 'Chris Creel' });
      expect(run.response.statusCode).toBe(401);
      expect(run.nextCalled).toBe(false);
    });

    it('treats empty-string headers as missing (fails closed)', () => {
      const run = runMiddleware(
        {},
        {
          'tailscale-user-login': '',
          'tailscale-user-name': 'Chris Creel',
        },
      );
      expect(run.response.statusCode).toBe(401);
      expect(run.nextCalled).toBe(false);
    });
  });

  describe('with an allowlist', () => {
    it('passes a request whose login is in the allowlist', () => {
      const run = runMiddleware(
        { allowlist: ['chris@sc0red.com', 'heather@talkatlanta.info'] },
        {
          'tailscale-user-login': 'heather@talkatlanta.info',
          'tailscale-user-name': 'Heather',
        },
      );
      expect(run.nextCalled).toBe(true);
    });

    it('rejects with 403 a tailnet user not in the allowlist', () => {
      const run = runMiddleware(
        { allowlist: ['chris@sc0red.com'] },
        {
          'tailscale-user-login': 'guest@elsewhere.com',
          'tailscale-user-name': 'Guest',
        },
      );
      expect(run.nextCalled).toBe(false);
      expect(run.response.statusCode).toBe(403);
      const body = run.response.jsonBody as { error: string };
      expect(body.error).toContain('guest@elsewhere.com');
      expect(body.error).toContain('not permitted');
    });

    it('matches the allowlist case-insensitively (operator can type CHRIS@... and still get in)', () => {
      const run = runMiddleware(
        { allowlist: ['chris@sc0red.com'] },
        {
          'tailscale-user-login': 'CHRIS@sc0red.com',
          'tailscale-user-name': 'Chris',
        },
      );
      expect(run.nextCalled).toBe(true);
    });

    it('still 401s anonymous requests before checking the allowlist', () => {
      const run = runMiddleware({ allowlist: ['chris@sc0red.com'] }, {});
      expect(run.response.statusCode).toBe(401);
    });

    it('an empty allowlist is a valid emergency-stop — every authenticated user is 403d', () => {
      const run = runMiddleware({ allowlist: [] }, VALID_HEADERS);
      expect(run.response.statusCode).toBe(403);
      expect(run.nextCalled).toBe(false);
    });
  });

  describe('getTailscaleIdentity helper', () => {
    it('returns the identity that the middleware wrote to response.locals', () => {
      const run = runMiddleware({}, VALID_HEADERS);
      const identity = getTailscaleIdentity(run.response as unknown as Response);
      expect(identity).toEqual({ login: 'chris@sc0red.com', name: 'Chris Creel' });
    });

    it('returns undefined when no identity has been attached', () => {
      const response = buildResponse();
      expect(getTailscaleIdentity(response as unknown as Response)).toBeUndefined();
    });

    it('returns undefined when locals.tailscaleIdentity is the wrong shape', () => {
      const response = buildResponse();
      response.locals['tailscaleIdentity'] = { login: 'chris@sc0red.com' };
      expect(getTailscaleIdentity(response as unknown as Response)).toBeUndefined();
    });

    it('returns undefined when profilePic is present but the wrong type', () => {
      const response = buildResponse();
      response.locals['tailscaleIdentity'] = {
        login: 'chris@sc0red.com',
        name: 'Chris',
        profilePic: 42,
      };
      expect(getTailscaleIdentity(response as unknown as Response)).toBeUndefined();
    });
  });
});
