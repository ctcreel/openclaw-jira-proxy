import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkIdentityStatement } from './checks/identity-statement';
import { checkInjectionTargets } from './checks/injection-targets';
import { checkLegacyPatterns } from './checks/legacy-patterns';
import { checkNoLiteralMustache } from './checks/no-literal-mustache';
import { checkTemplatesExist } from './checks/templates-exist';
import { checkToolUseDeclared } from './checks/tool-use-declared';
import { findSharedDir } from './injection-scan';
import { loadAgentConfig } from './load-config';
import type { AuditFinding, AuditReport } from './types';

export interface AuditOptions {
  /** Optional override for the workspaces/shared/ dir (multi-agent repos). */
  readonly sharedDir?: string;
}

/**
 * Run every workspace audit check against an agent workspace and return the
 * aggregated report. Findings sort error → warning, then by rule name + path
 * for stable output.
 */
// noqa: NAMING001 — `audit` is a verb; public API name, renaming to runAudit muddies meaning.
export async function auditAgent(
  agentDir: string,
  options: AuditOptions = {},
): Promise<AuditReport> {
  if (!existsSync(join(agentDir, 'clawndom.yaml'))) {
    return {
      agentDir,
      findings: [
        {
          severity: 'error',
          rule: 'missing-clawndom-yaml',
          message: `No clawndom.yaml found at ${join(agentDir, 'clawndom.yaml')}. The audit target must be the agent workspace root.`,
          hint: 'Pass the directory that contains clawndom.yaml (e.g. workspaces/winston).',
        },
      ],
    };
  }

  const { config } = await loadAgentConfig(agentDir);
  const sharedDir = options.sharedDir ?? findSharedDir(agentDir);
  const context = { agentDir, sharedDir };

  const findings: AuditFinding[] = [];
  findings.push(...checkTemplatesExist(agentDir, config));
  findings.push(...(await checkInjectionTargets(agentDir, config, context)));
  findings.push(...(await checkNoLiteralMustache(agentDir, config, context)));
  findings.push(...(await checkToolUseDeclared(agentDir, config)));
  findings.push(...(await checkIdentityStatement(agentDir, config)));
  findings.push(...(await checkLegacyPatterns(agentDir, config)));

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
    if ((a.path ?? '') !== (b.path ?? '')) return (a.path ?? '').localeCompare(b.path ?? '');
    return (a.line ?? 0) - (b.line ?? 0);
  });

  return { agentDir, findings };
}

export type { AuditFinding, AuditReport } from './types';
