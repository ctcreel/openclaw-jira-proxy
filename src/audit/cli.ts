#!/usr/bin/env node
import { argv, exit, stdout } from 'node:process';

import { parseAuditArgs } from './cli-args';
import { auditAgent } from './index';
import { getCountsBySeverity } from './types';
import type { AuditFinding } from './types';

const HELP = `clawndom audit — validate an agent workspace against the canonical layout.

Usage:
  clawndom-audit <agent-dir> [--shared-dir <path>] [--json]

Arguments:
  <agent-dir>            Path to the agent workspace (the directory containing clawndom.yaml).

Options:
  --shared-dir <path>    Path to workspaces/shared/ for multi-agent repos.
                         If omitted, the audit auto-detects a sibling shared/ dir.
  --json                 Emit findings as JSON instead of human-readable output.
  -h, --help             Show this message.

Exit code is 0 when no errors are found (warnings allowed), 1 otherwise.
`;

async function runCli(): Promise<number> {
  const parsed = parseAuditArgs(argv.slice(2));
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${HELP}`);
    return 2;
  }

  const report = await auditAgent(parsed.agentDir, { sharedDir: parsed.sharedDir });

  if (parsed.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(renderHumanReport(parsed.agentDir, report.findings));
  }

  const counts = getCountsBySeverity(report.findings);
  return counts.error > 0 ? 1 : 0;
}

function renderHumanReport(agentDir: string, findings: readonly AuditFinding[]): string {
  if (findings.length === 0) {
    return `OK ${agentDir}: 0 findings.\n`;
  }
  const lines: string[] = [`audit ${agentDir}`];
  for (const f of findings) {
    const location =
      f.path !== undefined ? (f.line !== undefined ? `${f.path}:${f.line}` : f.path) : '';
    const header = `[${f.severity.toUpperCase()}] ${f.rule}${location ? ` (${location})` : ''}`;
    lines.push('', header, `  ${f.message}`);
    if (f.hint !== undefined) {
      lines.push(`  hint: ${f.hint}`);
    }
  }
  const counts = getCountsBySeverity(findings);
  lines.push('', `summary: ${counts.error} error(s), ${counts.warning} warning(s).`);
  return `${lines.join('\n')}\n`;
}

runCli()
  .then((code) => exit(code))
  .catch((err) => {
    process.stderr.write(`audit failed: ${(err as Error).message}\n`);
    if ((err as Error).stack !== undefined) {
      process.stderr.write(`${(err as Error).stack}\n`);
    }
    exit(2);
  });
