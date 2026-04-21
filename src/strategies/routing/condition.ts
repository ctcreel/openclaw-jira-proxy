import { z } from 'zod';

import { resolveFieldPath } from './field-path';

const regexFlagsSchema = z
  .string()
  .regex(/^[gimsuy]*$/, 'flags must contain only g, i, m, s, u, y')
  .optional();

const equalsLeafSchema = z.object({
  equals: z.object({
    field: z.string().min(1),
    value: z.string(),
  }),
});

const inLeafSchema = z.object({
  in: z.object({
    field: z.string().min(1),
    values: z.array(z.string()).min(1),
  }),
});

const matchesLeafSchema = z.object({
  matches: z.object({
    field: z.string().min(1),
    pattern: z.string().refine(
      (p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'pattern must be a valid regular expression' },
    ),
    flags: regexFlagsSchema,
  }),
});

const existsLeafSchema = z.object({
  exists: z.object({
    field: z.string().min(1),
  }),
});

export type Condition =
  | { equals: { field: string; value: string } }
  | { in: { field: string; values: string[] } }
  | { matches: { field: string; pattern: string; flags?: string } }
  | { exists: { field: string } }
  | { all_of: Condition[] }
  | { any_of: Condition[] }
  | { not: Condition };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    equalsLeafSchema,
    inLeafSchema,
    matchesLeafSchema,
    existsLeafSchema,
    z.object({ all_of: z.array(conditionSchema) }),
    z.object({ any_of: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
  ]),
);

function stringifyResolved(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function evaluateEquals(payload: unknown, field: string, target: string): boolean {
  const resolved = resolveFieldPath(payload, field);
  if (resolved === undefined || resolved === null) {
    return false;
  }
  if (Array.isArray(resolved)) {
    return resolved.some((element) => stringifyResolved(element) === target);
  }
  return stringifyResolved(resolved) === target;
}

function evaluateIn(payload: unknown, field: string, values: readonly string[]): boolean {
  const resolved = resolveFieldPath(payload, field);
  if (resolved === undefined || resolved === null) {
    return false;
  }
  const targets = new Set(values);
  if (Array.isArray(resolved)) {
    return resolved.some((element) => targets.has(stringifyResolved(element)));
  }
  return targets.has(stringifyResolved(resolved));
}

function evaluateMatches(
  payload: unknown,
  field: string,
  pattern: string,
  flags: string | undefined,
): boolean {
  const resolved = resolveFieldPath(payload, field);
  if (resolved === undefined || resolved === null) {
    return false;
  }
  const regex = new RegExp(pattern, flags);
  if (Array.isArray(resolved)) {
    return resolved.some((element) => regex.test(stringifyResolved(element)));
  }
  return regex.test(stringifyResolved(resolved));
}

function evaluateExists(payload: unknown, field: string): boolean {
  const resolved = resolveFieldPath(payload, field);
  return resolved !== undefined && resolved !== null;
}

export function evaluateCondition(payload: unknown, condition: Condition): boolean {
  if ('equals' in condition) {
    return evaluateEquals(payload, condition.equals.field, condition.equals.value);
  }
  if ('in' in condition) {
    return evaluateIn(payload, condition.in.field, condition.in.values);
  }
  if ('matches' in condition) {
    return evaluateMatches(
      payload,
      condition.matches.field,
      condition.matches.pattern,
      condition.matches.flags,
    );
  }
  if ('exists' in condition) {
    return evaluateExists(payload, condition.exists.field);
  }
  if ('all_of' in condition) {
    return condition.all_of.every((child) => evaluateCondition(payload, child));
  }
  if ('any_of' in condition) {
    return condition.any_of.some((child) => evaluateCondition(payload, child));
  }
  return !evaluateCondition(payload, condition.not);
}
