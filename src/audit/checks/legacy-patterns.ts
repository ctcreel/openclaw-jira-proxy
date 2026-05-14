import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Warn-level checks for prose patterns that worked in older eras but no longer
 * match the live runtime. None of these crash the agent; they degrade signal
 * (model spends turns on stale instructions, attempts an MCP call that doesn't
 * resolve, writes to a memory file no operator reads).
 *
 * Hard-error tier is reserved for cases that break execution; everything here
 * is a "you forgot to clean this up" nudge.
 */
interface LegacyPattern {
  readonly rule: string;
  readonly regex: RegExp;
  readonly message: (snippet: string) => string;
  readonly hint: string;
}

const PATTERNS: readonly LegacyPattern[] = [
  {
    rule: 'legacy-mcp-claude-ai-prefix',
    regex: /mcp__claude_ai_[A-Z][A-Za-z0-9_]*/g,
    message: (snippet) =>
      `References \`${snippet}\` — the legacy Claude.ai MCP prefix. The Atlassian MCP server is registered as \`mcp__atlassian__*\` on production hosts; the claude_ai_-prefixed names do not resolve.`,
    hint: 'Rename to the matching `mcp__atlassian__*` (or `mcp__sonarqube__*` / etc.) tool, or remove the reference if the call is handled by an agency-tools function instead.',
  },
  {
    rule: 'legacy-memory-file-write',
    regex: /\bmemory\/[a-z][a-z0-9-]*\.(md|log)\b/g,
    message: (snippet) =>
      `Instructs the agent to write to \`${snippet}\`. Per-template memory files are the OpenClaw pattern; under Clawndom, every tool call is already recorded in /var/log/clawndom-*/audit.log.`,
    hint: "Delete the memory-file write step. The audit log is the authoritative trail; for durable lessons, use Clawndom's memory namespaces instead.",
  },
  {
    rule: 'legacy-google-api-import',
    regex: /\bfrom\s+google_api\s+import\b|sys\.path\.insert\([^)]*tools[^)]*\)/g,
    message: (snippet) =>
      `Mentions the retired \`google_api\` shell-out pattern (\`${snippet.trim()}\`). The per-agent tools/ directory was retired in May 2026; templates dispatch tools via SPE-2078 \`tool_use\` blocks now.`,
    hint: "Replace the bash shell-out with a `tool_use` block referencing the matching `agency_tools.google.*` tool, and declare the tool in the route's `tools:` block in clawndom.yaml.",
  },
  {
    rule: 'legacy-tools-md-injection',
    regex: /\{\{\s*system-doc:docs\/TOOLS\.md\s*\}\}/g,
    message: () =>
      'Injects `{{system-doc:docs/TOOLS.md}}`. For SPE-2078 workspaces, the tool inventory is declared per route in clawndom.yaml and registered with the tool-use API at job start — the prose catalog is redundant context.',
    hint: 'Remove the injection. Tool docs live in the agency-tools library; route-side `tools:` declarations are the runtime authority.',
  },
];

export async function checkLegacyPatterns(
  agentDir: string,
  config: AuditConfig,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const visitedPaths = new Set<string>();

  for (const routing of Object.values(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.messageTemplate === undefined) continue;
      const templatePath = join(agentDir, rule.messageTemplate);
      if (visitedPaths.has(templatePath)) continue;
      visitedPaths.add(templatePath);

      let source: string;
      try {
        source = await readFile(templatePath, 'utf-8');
      } catch {
        continue;
      }
      checkFile(rule.messageTemplate, source, findings);
    }
  }

  return findings;
}

function checkFile(displayPath: string, source: string, findings: AuditFinding[]): void {
  const lines = source.split('\n');
  for (const pattern of PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        const snippet = match[0];
        findings.push({
          severity: 'warning',
          rule: pattern.rule,
          message: pattern.message(snippet),
          path: displayPath,
          line: i + 1,
          hint: pattern.hint,
        });
      }
    }
  }
}
