import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditConfig } from '../load-config';
import { findInjections, resolveInjection } from '../injection-scan';
import type { ResolveContext } from '../injection-scan';
import type { AuditFinding } from '../types';

/**
 * Every `{{...:path}}` injection inside every reachable template must resolve
 * to a file on disk. Unresolvable injections render as empty strings at runtime
 * (depending on Nunjucks config) or crash the render — either way it's a
 * silent or loud bug. Catch it offline against every template a routing rule
 * names.
 *
 * Also flags an inconsistent shape that the layout doc forbids: bare-filename
 * `{{system-doc:...}}` references that don't start with `docs/`. Those work in
 * the current renderer (it resolves against agentDir), but they break the rule
 * that every injection lives under `docs/` so the path shape stays uniform.
 */
export async function checkInjectionTargets(
  agentDir: string,
  config: AuditConfig,
  context: ResolveContext,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const visited = new Set<string>();

  async function walk(absolutePath: string, displayPath: string): Promise<void> {
    if (visited.has(absolutePath)) return;
    visited.add(absolutePath);

    let source: string;
    try {
      source = await readFile(absolutePath, 'utf-8');
    } catch {
      return;
    }

    for (const ref of findInjections(source)) {
      if (ref.kind === 'system-doc' || ref.kind === 'doc') {
        if (!ref.target.includes('/')) {
          findings.push({
            severity: 'error',
            rule: 'injection-at-workspace-root',
            message: `${displayPath} references {{${ref.kind}:${ref.target}}} (bare filename). Agent-workspace injections must live in a subdirectory (e.g. identity/, shared/), not at the workspace root next to clawndom.yaml.`,
            path: displayPath,
            line: ref.line,
            hint: `Move the file into a subdirectory and update the injection accordingly (e.g. {{${ref.kind}:shared/${ref.target}}}).`,
          });
        }
      }

      const resolution = resolveInjection(ref, context);
      if (!resolution.exists) {
        findings.push({
          severity: 'error',
          rule: 'unresolved-injection',
          message: `${displayPath} references {{${ref.kind}:${ref.target}}}, but the target file does not exist.`,
          path: displayPath,
          line: ref.line,
          hint: 'Check the path; create the file, or remove the injection.',
        });
        continue;
      }

      await walk(resolution.absolutePath, resolution.displayPath);
    }
  }

  for (const routing of Object.values(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.messageTemplate === undefined) continue;
      const templatePath = join(agentDir, rule.messageTemplate);
      await walk(templatePath, rule.messageTemplate);
    }
  }

  return findings;
}
