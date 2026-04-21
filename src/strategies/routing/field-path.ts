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
    current = readIndexed(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }

  return current;
}

/**
 * Safe property access for `unknown` values. Returns undefined when the
 * subject is not an object/array. Isolates the one narrowing cast needed
 * to index into a non-null object — TypeScript can't express
 * "any object is indexable by string" without a type assertion, so we
 * pay that tax once here rather than scattering `as` casts at call sites.
 */
function readIndexed(subject: unknown, key: string): unknown {
  if (subject === null || subject === undefined || typeof subject !== 'object') {
    return undefined;
  }
  return (subject as Record<string, unknown>)[key];
}
