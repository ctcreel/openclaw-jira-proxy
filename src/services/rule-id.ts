/**
 * A rule's stable identifier — the key used by sidecar layout files,
 * editor cross-references, and audit findings. Distinct from `name:`,
 * which is human prose and can change.
 *
 * Resolution:
 *   1. Explicit `id:` field in clawndom.yaml takes precedence.
 *   2. Otherwise, kebab-slug of `name:`.
 *   3. Rules with neither id nor name get a positional fallback so
 *      structurally-incomplete configs still produce SOME identifier
 *      (the audit will flag them separately).
 *
 * The kebab-slug is deterministic per-rule-name so the default-id
 * behavior is stable across reads — a rule that never had its id set
 * explicitly has the same effective id every time the file is parsed.
 */

const NON_SLUG_RUN = /[^a-z0-9]+/g;
const LEADING_DASHES = /^-+/;
const TRAILING_DASHES = /-+$/;
const LEADING_NON_LETTER = /^[^a-z]+/;

interface RuleIdInputs {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
}

export function resolveRuleId(rule: RuleIdInputs, fallbackIndex: number): string {
  if (rule.id !== undefined) return rule.id;
  if (rule.name !== undefined) {
    const slug = formatAsKebab(rule.name);
    if (slug !== '') return slug;
  }
  return `rule-${fallbackIndex}`;
}

export function formatAsKebab(input: string): string {
  return input
    .toLowerCase()
    .replace(NON_SLUG_RUN, '-')
    .replace(LEADING_DASHES, '')
    .replace(TRAILING_DASHES, '')
    .replace(LEADING_NON_LETTER, '');
}
