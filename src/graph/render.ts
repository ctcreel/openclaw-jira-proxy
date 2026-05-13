import { collectInternalTaskTargets, extractEqualsValue } from '../audit/config-helpers';
import type { AuditConfig, AuditRule } from '../audit/load-config';
import { loadAgentConfig } from '../audit/load-config';
import { resolveRuleId } from '../services/rule-id';

/**
 * Render an agent workspace's clawndom.yaml as a Mermaid flowchart.
 *
 * Nodes:
 *   - Triggers: schedule (cron), webhook providers, internal task entries.
 *   - Rules.
 *   - Templates.
 *   - Tools (the `module.python:` declarations on rules).
 *
 * Edges:
 *   - Trigger → rule (provider/source → rule).
 *   - Rule → template (rule.messageTemplate).
 *   - Rule → tool (rule.tools).
 *   - Rule → rule (dispatched-to internal target, when `dispatches:` lists
 *     a task type matching a routing.internal rule).
 *
 * Output is Mermaid-flavored markdown that GitHub renders inline in a
 * fenced ```mermaid block. The output is deterministic so re-rendering on
 * every push produces a stable diff.
 */

const TRIGGER_SYMBOL_BY_PROVIDER: Record<string, string> = {
  schedule: '⏰',
  internal: '↩',
  slack: '💬',
  jira: '📋',
  github: '🐙',
};

export interface RenderOptions {
  /** Optional agent name to label the diagram subgraph. */
  agentName?: string;
}

export async function renderGraph(
  agentDir: string,
  config: AuditConfig,
  options: RenderOptions = {},
): Promise<string> {
  const lines: string[] = [];
  lines.push('```mermaid');
  lines.push('flowchart LR');
  if (options.agentName !== undefined) {
    lines.push(`  %% Workspace: ${options.agentName}`);
  }

  // Internal-task targets: rule-name → taskType so dispatch edges can find them.
  const internalRuleByTaskType = collectInternalTaskTargets(config, (rule, i) =>
    makeRuleNodeId('internal', rule, i),
  );

  for (const [providerName, routing] of Object.entries(config.routing)) {
    if (routing.rules.length === 0) continue;
    lines.push('');
    lines.push(`  subgraph ${sanitizeId(providerName)}["${formatProviderLabel(providerName)}"]`);

    for (let i = 0; i < routing.rules.length; i += 1) {
      const rule = routing.rules[i]!;
      const ruleId = makeRuleNodeId(providerName, rule, i);
      const ruleLabel = rule.name ?? `rule[${i}]`;
      const triggerHint = formatTriggerHint(providerName, rule);
      // GitHub's Mermaid renderer fails silently on mixed HTML in labels
      // (`<br/>` + `<i>` together would parse on mermaid.live but produce
      // an empty render on github.com). Use plain text with a thin-space
      // separator — readable, and stable across renderers.
      const label = triggerHint ? `${ruleLabel} · ${encodeMermaid(triggerHint)}` : ruleLabel;
      lines.push(`    ${ruleId}["${label}"]`);
    }
    lines.push('  end');
  }

  // Templates + tools live outside the per-provider subgraphs because they
  // can be the target of edges from multiple rules and ought to render once.
  const templateNodes = new Map<string, string>(); // path → node id
  const toolNodes = new Map<string, string>(); // module → node id

  for (const [providerName, routing] of Object.entries(config.routing)) {
    for (let i = 0; i < routing.rules.length; i += 1) {
      const rule = routing.rules[i]!;
      const ruleId = makeRuleNodeId(providerName, rule, i);

      if (rule.messageTemplate !== undefined) {
        const tplId = makeTemplateNodeId(rule.messageTemplate);
        if (!templateNodes.has(rule.messageTemplate)) {
          templateNodes.set(rule.messageTemplate, tplId);
          lines.push(`  ${tplId}{{"📄 ${encodeMermaid(getBasename(rule.messageTemplate))}"}}`);
        }
        lines.push(`  ${ruleId} --> ${tplId}`);
      }

      for (const ref of rule.tools ?? []) {
        const module = (ref as { 'module.python': string })['module.python'];
        const id = makeToolNodeId(module);
        if (!toolNodes.has(module)) {
          toolNodes.set(module, id);
          lines.push(`  ${id}(["🔧 ${encodeMermaid(getToolShortName(module))}"])`);
        }
        lines.push(`  ${ruleId} -.-> ${id}`);
      }

      for (const taskType of rule.dispatches) {
        const target = internalRuleByTaskType.get(taskType);
        if (target !== undefined) {
          lines.push(`  ${ruleId} ==> ${target}`);
        }
      }
    }
  }

  // Surface the source agent dir in a footer comment so the renderer is
  // round-trippable.
  if (agentDir !== '') {
    lines.push('');
    lines.push(`  %% Rendered from ${agentDir}`);
  }
  lines.push('```');
  return `${lines.join('\n')}\n`;
}

function formatTriggerHint(providerName: string, rule: AuditRule): string | undefined {
  if (providerName === 'schedule' && rule.cron !== undefined) return `cron ${rule.cron}`;
  if (providerName === 'internal') {
    const taskType = extractEqualsValue(rule.condition, 'taskType');
    if (taskType !== undefined) return `taskType: ${taskType}`;
  }
  return undefined;
}

function formatProviderLabel(providerName: string): string {
  const symbol = TRIGGER_SYMBOL_BY_PROVIDER[providerName] ?? '🔌';
  return `${symbol} ${providerName}`;
}

function makeRuleNodeId(providerName: string, rule: AuditRule, index: number): string {
  const ruleId = resolveRuleId(rule, index);
  return `${sanitizeId(providerName)}__${ruleId.replace(/-/g, '_')}`;
}

function makeTemplateNodeId(path: string): string {
  return `tpl__${path.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function makeToolNodeId(module: string): string {
  return `tool__${module.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function getBasename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] as string;
}

function getToolShortName(module: string): string {
  const parts = module.split('.');
  return parts[parts.length - 1] as string;
}

function encodeMermaid(text: string): string {
  return text.replace(/"/g, '&quot;');
}

export async function renderGraphFromDisk(
  agentDir: string,
  options: RenderOptions = {},
): Promise<string> {
  // Reuses the audit's loader for schema validation + defaults application.
  const loaded = await loadAgentConfig(agentDir);
  return renderGraph(agentDir, loaded.config, options);
}
