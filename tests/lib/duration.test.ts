import { describe, expect, it } from 'vitest';

import { parseDurationToMs } from '../../src/lib/duration';

describe('parseDurationToMs', () => {
  it.each([
    ['100ms', 100],
    ['1ms', 1],
    ['30s', 30_000],
    ['1m', 60_000],
    ['5m', 300_000],
    ['1h', 3_600_000],
    ['24h', 86_400_000],
    ['1d', 86_400_000],
    ['7d', 604_800_000],
    ['30d', 2_592_000_000],
  ])('parses %s to %d ms', (input, expected) => {
    expect(parseDurationToMs(input)).toBe(expected);
  });

  it.each([
    [''],
    ['7'],
    ['d7'],
    ['7 d'],
    ['1.5h'],
    ['7days'],
    ['-1h'],
    ['7w'],
    ['forever'],
    ['7 days'],
    ['1h30m'],
  ])('rejects %s', (input) => {
    expect(() => parseDurationToMs(input)).toThrow();
  });
});
