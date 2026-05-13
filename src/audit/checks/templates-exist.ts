import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Every `messageTemplate` path declared in a routing rule must resolve to a
 * file on disk. A missing template is a runtime-crash bug — the rule matches
 * a webhook, the worker tries to render, and the read fails after the event
 * has already been dequeued. Catch it offline.
 */
export function checkTemplatesExist(agentDir: string, config: AuditConfig): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const [providerName, routing] of Object.entries(config.routing)) {
    routing.rules.forEach((rule, index) => {
      if (rule.messageTemplate === undefined) return;
      const absolutePath = join(agentDir, rule.messageTemplate);
      if (existsSync(absolutePath)) return;
      const ruleLabel = rule.name ?? `rule[${index}]`;
      findings.push({
        severity: 'error',
        rule: 'missing-template',
        message: `routing.${providerName}.${ruleLabel} declares messageTemplate "${rule.messageTemplate}" but the file does not exist.`,
        path: 'clawndom.yaml',
        hint: 'Create the template file, or update the messageTemplate path to a real file.',
      });
    });
  }
  return findings;
}
