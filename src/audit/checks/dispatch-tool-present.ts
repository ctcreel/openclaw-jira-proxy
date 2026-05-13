import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Dispatch-tool presence check.
 *
 * A rule that declares `dispatches: [taskType, ...]` will POST to
 * `/api/tasks` at run time. The clean way to make that call is via
 * `agency_tools.clawndom.dispatch_task` (a typed Python tool that
 * wraps the API call) — the runtime injects its signature + docstring
 * into the model's tool descriptors and the template stops carrying a
 * hand-rolled curl example.
 *
 * This check enforces the contract: any rule with non-empty
 * `dispatches:` must also list `module.python:
 * agency_tools.clawndom.dispatch_task` on its `tools:` block.
 *
 * Severity is `warning` during the migration window (workspaces have
 * `dispatches:` declared but may still be on the curl pattern). Flips
 * to error once every workspace has fully migrated.
 */

const DISPATCH_TOOL_MODULE = 'agency_tools.clawndom.dispatch_task';

export function checkDispatchToolPresent(config: AuditConfig): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const [providerName, routing] of Object.entries(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.dispatches.length === 0) continue;
      if (hasDispatchTool(rule.tools)) continue;
      const ruleLabel = rule.name ?? '<unnamed>';
      findings.push({
        severity: 'warning',
        rule: 'dispatch-tool-missing',
        message: `routing.${providerName}.${ruleLabel} declares \`dispatches: [${rule.dispatches.join(', ')}]\` but does not list \`${DISPATCH_TOOL_MODULE}\` on its \`tools:\` block.`,
        path: 'clawndom.yaml',
        hint: `Add \`- module.python: ${DISPATCH_TOOL_MODULE}\` to the rule's \`tools:\` block so the runtime injects the tool's typed signature instead of relying on a hand-rolled \`curl /api/tasks\` example in the template.`,
      });
    }
  }

  return findings;
}

function hasDispatchTool(tools: ReadonlyArray<unknown> | undefined): boolean {
  if (tools === undefined) return false;
  for (const ref of tools) {
    const module = (ref as { 'module.python'?: unknown })['module.python'];
    if (module === DISPATCH_TOOL_MODULE) return true;
  }
  return false;
}
