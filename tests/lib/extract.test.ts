import { describe, it, expect } from 'vitest';
import type { Request } from 'express';

import {
  readString,
  getOptionalStringField,
  getScalarField,
  getStringField,
  getStringHeader,
  getStringParameter,
  getStringQuery,
  isPlainObject,
} from '../../src/lib/extract';

// Minimal Express request stub — only the surface the extractors read.
function makeRequest(parts: Partial<Pick<Request, 'headers' | 'params' | 'query'>>): Request {
  return {
    headers: {},
    params: {},
    query: {},
    ...parts,
  } as Request;
}

describe('isPlainObject', () => {
  it('accepts a plain object', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('rejects null (the typeof-null-is-object gotcha)', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('rejects undefined, primitives, and arrays', () => {
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
  });
});

describe('readString', () => {
  it('returns the string when given a non-empty string', () => {
    expect(readString('x')).toBe('x');
  });

  it('returns undefined for everything else', () => {
    expect(readString('')).toBeUndefined();
    expect(readString(undefined)).toBeUndefined();
    expect(readString(null)).toBeUndefined();
    expect(readString(0)).toBeUndefined();
    expect(readString({})).toBeUndefined();
    expect(readString([])).toBeUndefined();
  });
});

describe('getStringHeader', () => {
  it('returns a single-string header value', () => {
    const req = makeRequest({ headers: { 'x-foo': 'bar' } });
    expect(getStringHeader(req, 'x-foo')).toBe('bar');
  });

  it('returns undefined for a repeated header (string[])', () => {
    const req = makeRequest({ headers: { 'x-foo': ['a', 'b'] } });
    expect(getStringHeader(req, 'x-foo')).toBeUndefined();
  });

  it('returns undefined for a missing header', () => {
    expect(getStringHeader(makeRequest({}), 'x-foo')).toBeUndefined();
  });

  it('lowercases the header name to match Express normalization', () => {
    const req = makeRequest({ headers: { authorization: 'Bearer xyz' } });
    expect(getStringHeader(req, 'Authorization')).toBe('Bearer xyz');
  });
});

describe('getStringParameter', () => {
  it('returns a non-empty path param', () => {
    const req = makeRequest({ params: { id: 'abc' } });
    expect(getStringParameter(req, 'id')).toBe('abc');
  });

  it('returns undefined for an empty path param', () => {
    const req = makeRequest({ params: { id: '' } });
    expect(getStringParameter(req, 'id')).toBeUndefined();
  });

  it('returns undefined for a missing path param', () => {
    expect(getStringParameter(makeRequest({}), 'id')).toBeUndefined();
  });
});

describe('getStringQuery', () => {
  it('returns a non-empty single-string query value', () => {
    const req = makeRequest({ query: { agentId: 'patch' } });
    expect(getStringQuery(req, 'agentId')).toBe('patch');
  });

  it('returns undefined for a repeated query value (string[])', () => {
    const req = makeRequest({ query: { agentId: ['a', 'b'] } });
    expect(getStringQuery(req, 'agentId')).toBeUndefined();
  });

  it('returns undefined for a parsed-object query value (ParsedQs)', () => {
    // `?agentId[name]=x` parses to an object, not a string.
    const req = makeRequest({ query: { agentId: { name: 'x' } } });
    expect(getStringQuery(req, 'agentId')).toBeUndefined();
  });

  it('returns undefined for empty / missing query', () => {
    expect(getStringQuery(makeRequest({ query: { agentId: '' } }), 'agentId')).toBeUndefined();
    expect(getStringQuery(makeRequest({}), 'agentId')).toBeUndefined();
  });
});

describe('getStringField', () => {
  it('reads a nested string via dotted path', () => {
    expect(getStringField({ issue: { key: 'SPE-1' } }, 'issue.key')).toBe('SPE-1');
  });

  it('returns the default fallback when missing', () => {
    expect(getStringField({}, 'issue.key')).toBe('?');
  });

  it('returns the explicit fallback when missing', () => {
    expect(getStringField({}, 'issue.key', 'NOPE')).toBe('NOPE');
  });

  it('returns the fallback when the value is the wrong type', () => {
    expect(getStringField({ issue: { key: 42 } }, 'issue.key')).toBe('?');
    expect(getStringField({ issue: { key: null } }, 'issue.key')).toBe('?');
  });
});

describe('getOptionalStringField', () => {
  it('returns the string when present and non-empty', () => {
    expect(getOptionalStringField({ a: 'x' }, 'a')).toBe('x');
  });

  it('returns undefined for empty strings, missing fields, or wrong types', () => {
    expect(getOptionalStringField({ a: '' }, 'a')).toBeUndefined();
    expect(getOptionalStringField({}, 'a')).toBeUndefined();
    expect(getOptionalStringField({ a: 42 }, 'a')).toBeUndefined();
  });
});

describe('getScalarField', () => {
  it('returns strings and numbers as-is', () => {
    expect(getScalarField({ n: 42 }, 'n')).toBe(42);
    expect(getScalarField({ n: '42' }, 'n')).toBe('42');
  });

  it('rejects objects, arrays, booleans, null', () => {
    expect(getScalarField({ n: true }, 'n')).toBeUndefined();
    expect(getScalarField({ n: [] }, 'n')).toBeUndefined();
    expect(getScalarField({ n: {} }, 'n')).toBeUndefined();
    expect(getScalarField({ n: null }, 'n')).toBeUndefined();
    expect(getScalarField({}, 'n')).toBeUndefined();
  });
});
