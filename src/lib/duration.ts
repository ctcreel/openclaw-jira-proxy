/**
 * Parse human-readable duration strings (e.g. `"7d"`, `"30m"`, `"15s"`,
 * `"500ms"`) into integer milliseconds. Used by the routing schema to accept
 * config values like `ttl: 7d`, `idleTimeout: 30m`.
 *
 * Supported units: `ms`, `s`, `m`, `h`, `d`.
 * Whole-number coefficients only — `"1.5h"` is rejected.
 *
 * Throws on malformed input so the Zod schema's `transform` step can surface
 * a clean validation error at config-load time.
 */
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MULTIPLIERS_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationToMs(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (match === null) {
    throw new Error(
      `Invalid duration "${value}". Expected <integer><unit> where unit is ms, s, m, h, or d (e.g. "7d", "30m").`,
    );
  }
  const [, coefficientStr, unit] = match as RegExpExecArray & [string, string, string];
  const multiplier = UNIT_MULTIPLIERS_MS[unit];
  if (multiplier === undefined) {
    // The regex's alternation guarantees this branch is unreachable, but
    // strict noUncheckedIndexedAccess requires a narrow.
    throw new Error(`Unsupported duration unit "${unit}".`);
  }
  return Number.parseInt(coefficientStr, 10) * multiplier;
}
