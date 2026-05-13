import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Declarative inter-rule dispatch.
 *
 * Internal-task dispatch is structurally a graph edge: rule A's template
 * POSTs to `/api/tasks` with `taskType: B`, which triggers rule B in
 * `routing.internal`. Today that edge is buried in template prose (a curl
 * call inside a fenced bash block). A visual editor — or anyone trying to
 * understand the cross-rule flow — has to grep templates to discover it.
 *
 * The fix: declare dispatches on the rule. `rule.dispatches: [<taskType>]`
 * lists the task types the rule's template will dispatch. The audit then
 * enforces two invariants:
 *
 * 1. Every `taskType: "X"` literal that appears in a curl-to-/api/tasks
 *    block in the template must be in the rule's `dispatches` list.
 *    (Otherwise the template fires an undeclared edge.)
 * 2. Every entry in `dispatches` must correspond to a `routing.internal`
 *    rule whose condition matches `taskType: <name>`.
 *    (Otherwise the edge dispatches into a void.)
 *
 * Both are warning-level today; flips to error once every workspace has
 * fully migrated.
 */

const TASK_TYPE_LITERAL = /"taskType"\s*:\s*"([a-z][a-z0-9-]*)"/g;

export async function checkDispatchDeclaration(
  agentDir: string,
  config: AuditConfig,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  const internalTargets = collectInternalTargets(config);

  for (const [providerName, routing] of Object.entries(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.messageTemplate === undefined) continue;
      const ruleLabel = rule.name ?? '<unnamed>';
      const templatePath = join(agentDir, rule.messageTemplate);
      let source: string;
      try {
        source = await readFile(templatePath, 'utf-8');
      } catch {
        continue;
      }

      const declared = new Set(rule.dispatches);
      const referenced = collectDispatchedTaskTypes(source);

      for (const [taskType, line] of referenced) {
        if (!declared.has(taskType)) {
          findings.push({
            severity: 'warning',
            rule: 'undeclared-dispatch',
            message: `${rule.messageTemplate} dispatches \`taskType: ${taskType}\` but routing.${providerName}.${ruleLabel} does not declare it under \`dispatches:\`.`,
            path: rule.messageTemplate,
            line,
            hint: `Add \`${taskType}\` to the rule's \`dispatches:\` block so the inter-rule edge is discoverable without parsing template prose.`,
          });
        }
      }

      for (const taskType of declared) {
        if (!internalTargets.has(taskType)) {
          findings.push({
            severity: 'warning',
            rule: 'dispatch-target-missing',
            message: `routing.${providerName}.${ruleLabel} declares dispatch \`${taskType}\` but no routing.internal rule matches that task type.`,
            path: 'clawndom.yaml',
            hint: `Add a rule under routing.internal whose condition equals taskType=${taskType}, or remove the entry from this rule's dispatches list. (Cross-agent dispatches into a different repo's routing.internal block are not yet linked by the audit and will surface as this warning today.)`,
          });
        }
      }
    }
  }

  return findings;
}

function collectInternalTargets(config: AuditConfig): Set<string> {
  const targets = new Set<string>();
  const internal = config.routing['internal'];
  if (internal === undefined) return targets;
  for (const rule of internal.rules) {
    const taskType = extractEqualsValue(rule.condition, 'taskType');
    if (taskType !== undefined) targets.add(taskType);
  }
  return targets;
}

function extractEqualsValue(condition: unknown, field: string): string | undefined {
  const equals = (condition as { equals?: { field: string; value: string } } | undefined)?.equals;
  if (equals === undefined || equals.field !== field) return undefined;
  return equals.value;
}

function collectDispatchedTaskTypes(source: string): Array<readonly [string, number]> {
  const out: Array<readonly [string, number]> = [];
  const seen = new Set<string>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    TASK_TYPE_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TASK_TYPE_LITERAL.exec(line)) !== null) {
      const taskType = match[1] as string;
      const key = `${taskType}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([taskType, i + 1] as const);
    }
  }
  return out;
}
