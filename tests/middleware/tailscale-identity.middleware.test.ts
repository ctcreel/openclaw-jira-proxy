import { describe, it, expect } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

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

function buildNext(): { called: boolean; fn: NextFunction } {
  const state = { called: false };
  const fn: NextFunction = () => {
    state.called = true;
  };
  return {
    get called(): boolean {
      return state.called;
    },
    fn,
  };
}

describe('tailscale-identity middleware', () => {
  describe('without an allowlist (any tailnet user allowed)', () => {
    it('passes through when both required headers are present', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({
        'tailscale-user-login': 'chris@sc0red.com',
        'tailscale-user-name': 'Chris Creel',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(next.called).toBe(true);
      expect(response.statusCode).toBe(0);
      expect(response.locals['tailscaleIdentity']).toEqual({
        login: 'chris@sc0red.com',
        name: 'Chris Creel',
      });
    });

    it('captures the optional profile-pic header when present', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({
        'tailscale-user-login': 'chris@sc0red.com',
        'tailscale-user-name': 'Chris Creel',
        'tailscale-user-profile-pic': 'https://example.com/me.png',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(next.called).toBe(true);
      expect(response.locals['tailscaleIdentity']).toEqual({
        login: 'chris@sc0red.com',
        name: 'Chris Creel',
        profilePic: 'https://example.com/me.png',
      });
    });

    it('rejects with 401 when both identity headers are missing (anonymous)', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({});
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(next.called).toBe(false);
      expect(response.statusCode).toBe(401);
      expect(response.jsonBody).toEqual({ error: 'Tailscale identity required' });
    });

    it('rejects with 401 when login is present but name is missing', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({ 'tailscale-user-login': 'chris@sc0red.com' });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(response.statusCode).toBe(401);
      expect(next.called).toBe(false);
    });

    it('rejects with 401 when name is present but login is missing', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({ 'tailscale-user-name': 'Chris Creel' });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(response.statusCode).toBe(401);
      expect(next.called).toBe(false);
    });

    it('treats empty-string headers as missing (fails closed)', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({
        'tailscale-user-login': '',
        'tailscale-user-name': 'Chris Creel',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(response.statusCode).toBe(401);
      expect(next.called).toBe(false);
    });
  });

  describe('with an allowlist', () => {
    it('passes a request whose login is in the allowlist', () => {
      const middleware = createTailscaleIdentityMiddleware({
        allowlist: ['chris@sc0red.com', 'heather@talkatlanta.info'],
      });
      const request = buildRequest({
        'tailscale-user-login': 'heather@talkatlanta.info',
        'tailscale-user-name': 'Heather',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(next.called).toBe(true);
    });

    it('rejects with 403 a tailnet user not in the allowlist', () => {
      const middleware = createTailscaleIdentityMiddleware({
        allowlist: ['chris@sc0red.com'],
      });
      const request = buildRequest({
        'tailscale-user-login': 'guest@elsewhere.com',
        'tailscale-user-name': 'Guest',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(next.called).toBe(false);
      expect(response.statusCode).toBe(403);
      const body = response.jsonBody as { error: string };
      expect(body.error).toContain('guest@elsewhere.com');
      expect(body.error).toContain('not permitted');
    });

    it('matches the allowlist case-insensitively (operator can type CHRIS@... and still get in)', () => {
      const middleware = createTailscaleIdentityMiddleware({
        allowlist: ['chris@sc0red.com'],
      });
      const request = buildRequest({
        'tailscale-user-login': 'CHRIS@sc0red.com',
        'tailscale-user-name': 'Chris',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(next.called).toBe(true);
    });

    it('still 401s anonymous requests before checking the allowlist', () => {
      const middleware = createTailscaleIdentityMiddleware({
        allowlist: ['chris@sc0red.com'],
      });
      const request = buildRequest({});
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(response.statusCode).toBe(401);
    });

    it('an empty allowlist is a valid emergency-stop — every authenticated user is 403d', () => {
      const middleware = createTailscaleIdentityMiddleware({ allowlist: [] });
      const request = buildRequest({
        'tailscale-user-login': 'chris@sc0red.com',
        'tailscale-user-name': 'Chris',
      });
      const response = buildResponse();
      const next = buildNext();

      middleware(request, response as unknown as Response, next.fn);

      expect(response.statusCode).toBe(403);
      expect(next.called).toBe(false);
    });
  });

  describe('getTailscaleIdentity helper', () => {
    it('returns the identity that the middleware wrote to response.locals', () => {
      const middleware = createTailscaleIdentityMiddleware({});
      const request = buildRequest({
        'tailscale-user-login': 'chris@sc0red.com',
        'tailscale-user-name': 'Chris Creel',
      });
      const response = buildResponse();
      const next = buildNext();
      middleware(request, response as unknown as Response, next.fn);

      const identity = getTailscaleIdentity(response as unknown as Response);
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
