import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Every tool name that appears in a template's `tool_use` prose must be
 * declared on the route's `tools:` block. The reverse direction (declared
 * but unused) is not a bug — declaring a tool you might call is fine. But
 * an UNDECLARED tool name in a template prose means the model will emit a
 * `tool_use` block at runtime that the executor refuses to dispatch.
 *
 * This is the bug we hit mid-session with handle-cancellation:
 * `calendar_list_events` was referenced in template prose, the route only
 * declared `gmail_*` tools, the calendar call would have failed the first
 * time triage hit a real cancellation.
 *
 * The check is conservative: it looks for the `"name": "<tool>"` shape inside
 * tool_use code fences AND the bare backtick form ` `tool_name` ` in steps that
 * say "emit a `<tool>` tool_use block". False negatives are possible (e.g. the
 * template names the tool only in narrative prose without quoting); false
 * positives are rare because we anchor to either the JSON or the backtick.
 */

const TOOL_USE_BLOCK_REGEX = /"name"\s*:\s*"([a-z][a-z0-9_]*)"/g;
const BACKTICK_TOOL_HINT_REGEX = /Emit\s+a\s+`([a-z][a-z0-9_]*)`\s+`tool_use`\s+block/gi;

export async function checkToolUseDeclared(
  agentDir: string,
  config: AuditConfig,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  for (const [providerName, routing] of Object.entries(config.routing)) {
    for (let i = 0; i < routing.rules.length; i += 1) {
      const rule = routing.rules[i]!;
      if (rule.messageTemplate === undefined) continue;

      const declared = new Set<string>();
      for (const ref of rule.tools ?? []) {
        const module = (ref as { 'module.python'?: string })['module.python'];
        if (typeof module !== 'string') continue;
        // module.python: agency_tools.google.gmail_send → bare tool name is the last segment.
        const last = module.split('.').pop();
        if (last !== undefined) declared.add(last);
      }

      const templatePath = join(agentDir, rule.messageTemplate);
      let source: string;
      try {
        source = await readFile(templatePath, 'utf-8');
      } catch {
        continue;
      }

      const referenced = collectReferencedTools(source);

      const ruleLabel = rule.name ?? `rule[${i}]`;
      for (const { name, line } of referenced) {
        if (declared.has(name)) continue;
        findings.push({
          severity: 'error',
          rule: 'undeclared-tool',
          message: `${rule.messageTemplate} references tool \`${name}\` but it isn't declared on routing.${providerName}.${ruleLabel}.tools[].`,
          path: rule.messageTemplate,
          line,
          hint: `Add \`- module.python: agency_tools.<package>.${name}\` to the tools block on this route in clawndom.yaml.`,
        });
      }
    }
  }

  return findings;
}

interface ToolReference {
  readonly name: string;
  readonly line: number;
}

function collectReferencedTools(source: string): ToolReference[] {
  const refs: ToolReference[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    TOOL_USE_BLOCK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOOL_USE_BLOCK_REGEX.exec(line)) !== null) {
      const name = match[1];
      if (name === undefined) continue;
      const key = `${name}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ name, line: i + 1 });
    }
    BACKTICK_TOOL_HINT_REGEX.lastIndex = 0;
    while ((match = BACKTICK_TOOL_HINT_REGEX.exec(line)) !== null) {
      const name = match[1];
      if (name === undefined) continue;
      const key = `${name}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ name, line: i + 1 });
    }
  }
  return refs;
}
