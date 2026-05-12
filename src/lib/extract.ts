/**
 * Runtime guards + boundary extractors for Express requests and parsed
 * `unknown` payloads.
 *
 * The codebase has dozens of `typeof X !== 'string'` checks at HTTP
 * headers, request params, query strings, and dotted-path lookups into
 * webhook bodies. Each is legitimate — Express types headers as
 * `string | string[] | undefined`, query params as a union of four shapes,
 * and `resolveFieldPath()` returns `unknown` because the JSON shape is
 * provider-specific. But scattered across 25+ call sites the pattern reads
 * like defensive paranoia.
 *
 * Centralizing the narrows here means:
 *   1. Each boundary check exists in exactly one place.
 *   2. Call sites read as intent (`getStringHeader(req, 'authorization')`)
 *      instead of mechanical type-guarding.
 *   3. New TypeScript Express type updates land in one file.
 */

import type { Request } from 'express';

import { resolveFieldPath } from '../strategies/routing/field-path';

// ---------------------------------------------------------------------------
// Runtime type guards
// ---------------------------------------------------------------------------

/**
 * TypeScript-narrowing guard for plain objects. `typeof null === 'object'`
 * is a classic JS gotcha; this guard also excludes arrays so callers can
 * safely index by string keys without checking length.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Narrow an `unknown` value to `string` or `undefined`. Useful when walking
 * a typed-as-unknown payload field (`event.channel`, etc.) and you just
 * want the value when it's a string, default-handled otherwise.
 */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Express request extractors
// ---------------------------------------------------------------------------

/**
 * Return the single-string value of an HTTP header, else `undefined`.
 *
 * Express types `request.headers[name]` as `string | string[] | undefined`
 * because HTTP allows repeated headers. A hostile or misconfigured client
 * really CAN send two `X-Hub-Signature` values; this helper rejects that
 * case (returns `undefined`) so callers don't accidentally call string
 * methods on an array.
 */
export function getStringHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Return a non-empty path parameter, else `undefined`.
 *
 * Express types `request.params[name]` as `string | undefined`. Empty-string
 * values are treated as missing — callers downstream want either a usable
 * id or `undefined`, never `""`.
 */
export function getStringParameter(request: Request, name: string): string | undefined {
  const value = request.params[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Return a non-empty single-string query parameter, else `undefined`.
 *
 * Express types `request.query[name]` as
 * `string | string[] | ParsedQs | ParsedQs[] | undefined` (`?foo=a&foo=b`
 * is the array case). This helper only accepts the single-string shape.
 */
export function getStringQuery(request: Request, name: string): string | undefined {
  const value = request.query[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// JSON payload extractors
// ---------------------------------------------------------------------------

/**
 * Read a string from an `unknown` payload at a dotted path; fall back
 * when the field is missing or the wrong type. Default fallback is `'?'`
 * which matches the existing context-extraction convention.
 */
export function getStringField(payload: unknown, path: string, fallback = '?'): string {
  const value = resolveFieldPath(payload, path);
  return typeof value === 'string' ? value : fallback;
}

/**
 * Read a non-empty string from an `unknown` payload at a dotted path,
 * or `undefined` when missing/wrong-type/empty. Use this when the
 * downstream caller wants to discriminate "present" from "absent" rather
 * than fall back to a placeholder.
 */
export function getOptionalStringField(payload: unknown, path: string): string | undefined {
  const value = resolveFieldPath(payload, path);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a scalar (string OR number) from an `unknown` payload. Useful for
 * fields like PR / issue numbers that can arrive as either type depending
 * on the webhook source.
 */
export function getScalarField(payload: unknown, path: string): string | number | undefined {
  const value = resolveFieldPath(payload, path);
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
