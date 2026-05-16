import { z } from 'zod';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';

import { agentConfigSchema } from './agent-loader.service';

/**
 * Editor-UI write flow for `clawndom.yaml`. Three core operations on
 * routing rules — `rule.add`, `rule.update`, `rule.delete` — applied
 * to the YAML Document AST so the multi-paragraph decision comments
 * on existing rules survive the edit. A naive `parse → object →
 * dump` round-trip would nuke them.
 *
 * Workflow:
 *   1. Caller fetches the agent's existing `clawndom.yaml`.
 *   2. UI sends an `EditPayload` describing the operations.
 *   3. `processEdits` parses to a Document, applies each op against the
 *      AST, serializes back. Comments on untouched rules are
 *      preserved verbatim; comments on a `rule.delete` go with the
 *      rule (intentional — operator deleted the rule, the rationale
 *      is moot).
 *   4. The result is round-tripped through `agentConfigSchema` to
 *      fail-fast on edits that produced an invalid document.
 *   5. The caller writes to disk, branches, commits, pushes, opens
 *      a PR (see `workspace.controller.ts`).
 *
 * Out of scope (for v1): edits to `memory.namespaces`, `modelRules`,
 * top-level fields. Operators who need those can either edit by hand
 * (still working today) or wait for the editor UI to grow operations.
 */

const ruleAddSchema = z.object({
  op: z.literal('rule.add'),
  provider: z.string().min(1),
  rule: z.record(z.string().min(1), z.unknown()),
});

const ruleUpdateSchema = z.object({
  op: z.literal('rule.update'),
  provider: z.string().min(1),
  ruleName: z.string().min(1),
  // Partial — only fields the UI is changing are present. AST applier
  // replaces these on the targeted rule and leaves other fields (and
  // their comments) untouched.
  changes: z.record(z.string().min(1), z.unknown()),
});

const ruleDeleteSchema = z.object({
  op: z.literal('rule.delete'),
  provider: z.string().min(1),
  ruleName: z.string().min(1),
});

/**
 * Reorder a rule within its provider's `rules:` array. The drag-and-drop
 * editor needs this to let operators set the priority order in which
 * rules are evaluated — the first matching rule wins, so position
 * matters for overlap cases.
 *
 * `toIndex` is 0-indexed and clamped to `[0, rulesCount - 1]`. The
 * removed rule lands at `toIndex` *after* it's been pulled out of its
 * current slot, so moving rule at index 2 to index 0 simply puts it
 * first; moving 0 to 2 puts it third.
 */
const ruleMoveSchema = z.object({
  op: z.literal('rule.move'),
  provider: z.string().min(1),
  ruleName: z.string().min(1),
  toIndex: z.number().int().min(0),
});

export const editOperationSchema = z.discriminatedUnion('op', [
  ruleAddSchema,
  ruleUpdateSchema,
  ruleDeleteSchema,
  ruleMoveSchema,
]);

export const editPayloadSchema = z.object({
  /** Short summary used as the commit subject + PR title. */
  message: z.string().min(1).max(120),
  /** Long-form rationale used as the PR body. */
  description: z.string().default(''),
  /** Operations to apply, in order. */
  edits: z.array(editOperationSchema).min(1).max(50),
});

export type EditOperation = z.infer<typeof editOperationSchema>;
export type EditPayload = z.infer<typeof editPayloadSchema>;

export interface ApplyEditsResult {
  /** Serialized YAML with comments preserved. */
  readonly yaml: string;
  /** The post-edit parsed config, validated against `agentConfigSchema`. */
  readonly config: z.infer<typeof agentConfigSchema>;
}

/**
 * Apply an ordered list of edits to a `clawndom.yaml` source. Throws
 * with a descriptive message when:
 *   - A `rule.update` or `rule.delete` references an unknown provider
 *     or rule name (operator's UI is out of date with on-disk).
 *   - A `rule.add` collides with an existing rule name in that provider
 *     (operator must use `rule.update` instead).
 *   - The post-edit document fails `agentConfigSchema` parsing.
 *
 * Caller is responsible for capturing the result and writing it; this
 * function is pure (input → output, no filesystem, no git).
 */
export function processEdits(currentYaml: string, payload: EditPayload): ApplyEditsResult {
  const doc = parseDocument(currentYaml, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    throw new Error(
      `clawndom.yaml has YAML parse errors; refusing to edit: ${doc.errors.map((e) => e.message).join('; ')}`,
    );
  }

  for (const op of payload.edits) {
    processOne(doc, op);
  }

  const yaml = doc.toString();

  // Round-trip through Zod to guarantee the edit produced a structurally
  // valid config. The AST applier doesn't know about the high-level
  // schema (e.g. that `dispatches` must be a string array or that
  // `condition` follows the discriminated-union shape) — Zod does.
  const parsedJson: unknown = doc.toJSON();
  const validation = agentConfigSchema.safeParse(parsedJson);
  if (!validation.success) {
    throw new Error(
      `Post-edit config failed validation: ${validation.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  return { yaml, config: validation.data };
}

function processOne(doc: Document, op: EditOperation): void {
  const rulesSeq = locateRulesSeq(doc, op.provider);
  if (op.op === 'rule.add') {
    if (findRuleIndex(rulesSeq, op.rule['name']) !== -1) {
      throw new Error(
        `rule.add: rule named "${String(op.rule['name'])}" already exists under provider "${op.provider}"; use rule.update instead`,
      );
    }
    rulesSeq.add(op.rule);
    return;
  }
  if (op.op === 'rule.update') {
    const index = findRuleIndex(rulesSeq, op.ruleName);
    if (index === -1) {
      throw new Error(
        `rule.update: rule "${op.ruleName}" not found under provider "${op.provider}"`,
      );
    }
    const ruleNode = rulesSeq.get(index, true);
    if (!isMap(ruleNode)) {
      throw new Error(
        `rule.update: rule at index ${index} under provider "${op.provider}" is not a YAML map`,
      );
    }
    for (const [key, value] of Object.entries(op.changes)) {
      ruleNode.set(key, value);
    }
    return;
  }
  if (op.op === 'rule.delete') {
    const index = findRuleIndex(rulesSeq, op.ruleName);
    if (index === -1) {
      throw new Error(
        `rule.delete: rule "${op.ruleName}" not found under provider "${op.provider}"`,
      );
    }
    rulesSeq.delete(index);
    return;
  }
  // rule.move
  const fromIndex = findRuleIndex(rulesSeq, op.ruleName);
  if (fromIndex === -1) {
    throw new Error(`rule.move: rule "${op.ruleName}" not found under provider "${op.provider}"`);
  }
  const lastIndex = rulesSeq.items.length - 1;
  const clampedTo = Math.min(Math.max(op.toIndex, 0), lastIndex);
  if (clampedTo === fromIndex) return;
  const removed = rulesSeq.items[fromIndex];
  if (removed === undefined) {
    throw new Error(`rule.move: internal — rules item at index ${fromIndex} is undefined`);
  }
  rulesSeq.items.splice(fromIndex, 1);
  rulesSeq.items.splice(clampedTo, 0, removed);
}

function locateRulesSeq(doc: Document, provider: string): YAMLSeq {
  const routing = doc.get('routing', true);
  if (!isMap(routing)) {
    throw new Error('clawndom.yaml has no top-level routing map');
  }
  const providerNode = (routing as YAMLMap).get(provider, true);
  if (!isMap(providerNode)) {
    throw new Error(`provider "${provider}" not found under routing`);
  }
  const rulesNode = (providerNode as YAMLMap).get('rules', true);
  if (!isSeq(rulesNode)) {
    throw new Error(`routing.${provider}.rules is not a sequence`);
  }
  return rulesNode as YAMLSeq;
}

function findRuleIndex(rulesSeq: YAMLSeq, name: unknown): number {
  if (typeof name !== 'string' || name.length === 0) return -1;
  for (let i = 0; i < rulesSeq.items.length; i += 1) {
    const item = rulesSeq.get(i, true);
    if (isMap(item)) {
      const ruleName = (item as YAMLMap).get('name');
      if (typeof ruleName === 'string' && ruleName === name) return i;
    }
  }
  return -1;
}
