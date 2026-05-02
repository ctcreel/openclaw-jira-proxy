import { createHash } from 'node:crypto';

import { z } from 'zod';

import { runnerConfigSchema } from '../runners/types';
import type { RunnerConfig } from '../runners/types';

/**
 * Scheduled-task primitive — the unified shape behind both static
 * `routing.schedule` rules and runtime-created scheduled work. See
 * `openspec/specs/scheduled-tasks/spec.md` for the source of truth.
 *
 * Two seams keep this type stable across phases:
 *
 *   1. `runner` is a string discriminator that maps into the existing
 *      `runnerConfigSchema` discriminated union; the registry stays
 *      runner-agnostic. New runners land in `runnerConfigSchema` and
 *      flow through here for free.
 *   2. `createdBy` is a closed set today (`config | agent`). Phase 3's
 *      agent tool reuses `createdBy='agent'` plus a populated
 *      `createdByTraceId`; no new variant is needed when the tool ships.
 */

const cronWhenSchema = z.object({
  cron: z.string().min(1),
  timezone: z.string().min(1).optional(),
});

const fireAtWhenSchema = z.object({
  fireAt: z.number().int(),
});

/**
 * Discriminator-free union: cron and fireAt have non-overlapping required
 * keys, so a Zod union resolves unambiguously without a literal `kind`
 * field. This matches the spec — no extra discriminator vocabulary leaks
 * into the storage shape.
 */
export const whenSchema = z.union([cronWhenSchema, fireAtWhenSchema]);

export type CronWhen = z.infer<typeof cronWhenSchema>;
export type FireAtWhen = z.infer<typeof fireAtWhenSchema>;
export type ScheduledTaskWhen = z.infer<typeof whenSchema>;

export function isCronWhen(when: ScheduledTaskWhen): when is CronWhen {
  return 'cron' in when;
}

export function isFireAtWhen(when: ScheduledTaskWhen): when is FireAtWhen {
  return 'fireAt' in when;
}

const createdBySchema = z.enum(['config', 'agent']);
export type ScheduledTaskCreatedBy = z.infer<typeof createdBySchema>;

/**
 * The on-the-wire / on-disk shape. `payload` is opaque JSON forwarded to
 * the runner at fire time; `runnerConfig` is the runner-specific block
 * that the runner registry already knows how to interpret.
 */
export const scheduledTaskSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().min(1).optional(),
  when: whenSchema,
  runner: z.string().min(1),
  runnerConfig: runnerConfigSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  createdBy: createdBySchema,
  createdByTraceId: z.string().min(1).optional(),
  ttl: z.number().int().nonnegative().optional(),
  maxRuns: z.number().int().positive().optional(),
  runCount: z.number().int().nonnegative().default(0),
  createdAt: z.number().int().nonnegative(),
  nextFireAt: z.number().int().nonnegative().optional(),
});

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

/**
 * Content-hash id derivation for `createdBy=config` tasks.
 *
 * Identical config → identical id, so re-loading `clawndom.yaml` is
 * idempotent and never duplicates a record. Different agent / name /
 * when / runner / runnerConfig → different id; the test suite covers
 * key-order independence and per-field sensitivity.
 *
 * 16 hex chars (64 bits) — wider than `hashHeaders`' 12 because the
 * address space is global across agents, narrow enough to keep the
 * dashboard readable.
 */
// noqa: NAMING001
export function deriveConfigTaskId(parameters: {
  agentId: string;
  name: string;
  when: ScheduledTaskWhen;
  runner: string;
  runnerConfig: RunnerConfig;
}): string {
  const material = stableStringify({
    agentId: parameters.agentId,
    name: parameters.name,
    when: parameters.when,
    runner: parameters.runner,
    runnerConfig: parameters.runnerConfig,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Deterministic JSON serialization with sorted keys. Without it the
 * content hash would shift if a config writer reordered runnerConfig
 * fields, which would break the "stable id across restarts" guarantee.
 *
 * We can't lean on JSON.stringify's replacer for this — the replacer
 * receives values one at a time and JSON.stringify still iterates each
 * returned object's keys in its own insertion order. Instead, walk the
 * tree, build a fully sorted shape, then stringify normally.
 */
// noqa: NAMING001
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => sortKeysDeep(entry));
  const source = value as Record<string, unknown>;
  // Avoid `Array.prototype.toSorted` because the project targets a TS
  // lib older than ES2023 — slice + sort stays equivalent and lint-clean.
  const sortedKeys = [...Object.keys(source)].sort((a, b) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    out[key] = sortKeysDeep(source[key]);
  }
  return out;
}
