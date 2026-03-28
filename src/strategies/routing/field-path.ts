/**
 * Resolve a dot-notation field path against an unknown payload.
 * Returns the resolved value, or undefined if any segment is missing.
 *
 * Examples:
 *   resolveFieldPath({ a: { b: "c" } }, "a.b") → "c"
 *   resolveFieldPath({ a: { b: ["x", "y"] } }, "a.b") → ["x", "y"]
 *   resolveFieldPath({}, "a.b.c") → undefined
 */
export function resolveFieldPath(payload: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = payload;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
