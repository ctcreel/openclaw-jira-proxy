import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { collectCaptures } from '../config-helpers';
import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Template-input declaration.
 *
 * Templates today reference per-event variables (`{{ messageId }}`,
 * `{{ from }}`, `{{ issue.key }}`) without any schema enforcement. Change
 * the upstream context strategy or the dispatching payload shape and the
 * consumer template silently breaks at render time — undefined Nunjucks
 * variables render as empty strings.
 *
 * The fix: declare each rule's `inputs:` — the variables the template
 * expects to receive. The audit then enforces that every `{{ <ident> }}`
 * reference in the template body resolves to either a declared input or
 * the always-available `payload` variable. Bare-identifier references not
 * covered by `inputs:` raise an informational finding.
 *
 * Severity is `warning` today (informational nudge) so workspaces have a
 * migration window. Once every rule's inputs are declared, the level
 * flips to error.
 */

// Match top-of-expression bare identifiers — `{{ messageId }}`,
// `{{ from | upper }}`, etc. Skip dotted paths (`{{ issue.fields.summary }}`)
// because they reference a nested object whose root is what we'd check; we
// allow them through unannotated for now to keep the migration story narrow.
const NUNJUCKS_BARE_IDENT = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\||\}\})/g;

// Variables Clawndom's template engine always exposes regardless of the
// rule's inputs declaration.
const ALWAYS_AVAILABLE = new Set([
  'payload',
  // Common Nunjucks built-ins / loop variables.
  'loop',
]);

// Identifiers that are unambiguously something else: Nunjucks keywords,
// filters used in body position. Excluded to keep noise out of the audit.
const NUNJUCKS_KEYWORDS = new Set([
  'if',
  'else',
  'elif',
  'endif',
  'for',
  'endfor',
  'set',
  'block',
  'endblock',
  'extends',
  'include',
  'import',
  'macro',
  'endmacro',
  'true',
  'false',
  'none',
  'null',
  'and',
  'or',
  'not',
  'in',
]);

export async function checkTemplateInputs(
  agentDir: string,
  config: AuditConfig,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  for (const [providerName, routing] of Object.entries(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.messageTemplate === undefined) continue;
      if (rule.inputs.length === 0) continue; // Opt-in until migration completes.

      const templatePath = join(agentDir, rule.messageTemplate);
      let source: string;
      try {
        source = await readFile(templatePath, 'utf-8');
      } catch {
        continue;
      }

      const declared = new Set(rule.inputs);
      const referenced = collectCaptures(source, NUNJUCKS_BARE_IDENT);
      const ruleLabel = rule.name ?? '<unnamed>';

      for (const [ident, line] of referenced) {
        if (declared.has(ident)) continue;
        if (ALWAYS_AVAILABLE.has(ident)) continue;
        if (NUNJUCKS_KEYWORDS.has(ident)) continue;
        findings.push({
          severity: 'warning',
          rule: 'undeclared-template-input',
          message: `${rule.messageTemplate} references \`{{ ${ident} }}\` but routing.${providerName}.${ruleLabel} does not declare \`${ident}\` under \`inputs:\`.`,
          path: rule.messageTemplate,
          line,
          hint: `Add \`${ident}\` to the rule's \`inputs:\` list — it's the producer/consumer contract for what the dispatching task or context strategy must supply.`,
        });
      }
    }
  }

  return findings;
}
