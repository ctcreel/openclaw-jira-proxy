import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  findIdentityPath,
  loadIdentityStatement,
  type IdentityStatement,
} from '../identity-statement';
import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Identity-security-statement checks. Every agent workspace must carry a
 * structured trust-boundary declaration in `identity/IDENTITY.md` front-matter.
 * The audit verifies:
 *
 * 1. The file exists and parses.
 * 2. `runs_as` is set.
 * 3. Every `subject:` literal that appears in a template's `tool_use` block
 *    is covered by `impersonation_subjects` (else trust-boundary violation).
 * 4. Every memory namespace named on a route is covered by
 *    `memory_namespaces` (and declared in the agent's `memory.namespaces`).
 * 5. Tools referenced in templates have `tool_scopes` entries.
 */
export async function checkIdentityStatement(
  agentDir: string,
  config: AuditConfig,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const identityPath = findIdentityPath(agentDir);
  if (identityPath === undefined) {
    findings.push({
      severity: 'error',
      rule: 'missing-identity-statement',
      message:
        'No identity/IDENTITY.md found. Every agent workspace must declare its trust boundary in identity/IDENTITY.md.',
      hint: 'Create identity/IDENTITY.md with YAML front-matter declaring runs_as, impersonation_subjects, external_recipients, memory_namespaces, and tool_scopes.',
    });
    return findings;
  }

  let loaded: Awaited<ReturnType<typeof loadIdentityStatement>>;
  try {
    loaded = await loadIdentityStatement(identityPath);
  } catch (error) {
    findings.push({
      severity: 'error',
      rule: 'identity-statement-invalid',
      message: `identity/IDENTITY.md front-matter failed validation: ${(error as Error).message}`,
      path: 'identity/IDENTITY.md',
      hint: 'Check the YAML front-matter against the IdentityStatement schema.',
    });
    return findings;
  }

  if (loaded === null) {
    findings.push({
      severity: 'error',
      rule: 'identity-statement-missing-front-matter',
      message:
        'identity/IDENTITY.md has no YAML front-matter security statement. The trust boundary must be declared structurally, not only in prose.',
      path: 'identity/IDENTITY.md',
      hint: 'Add a `---`-delimited YAML front-matter block declaring runs_as, impersonation_subjects, etc.',
    });
    return findings;
  }

  const { statement } = loaded;
  findings.push(...(await checkImpersonationSubjects(agentDir, config, statement)));
  findings.push(...checkMemoryNamespaces(config, statement));
  findings.push(...(await checkToolScopes(agentDir, config, statement)));
  return findings;
}

const SUBJECT_LITERAL_PATTERN = /"subject"\s*:\s*"([^"]+)"/g;

async function checkImpersonationSubjects(
  agentDir: string,
  config: AuditConfig,
  statement: IdentityStatement,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const allowed = new Set(statement.impersonation_subjects);
  const seen = new Set<string>();

  for (const routing of Object.values(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.messageTemplate === undefined) continue;
      const templatePath = join(agentDir, rule.messageTemplate);
      let source: string;
      try {
        source = await readFile(templatePath, 'utf-8');
      } catch {
        continue;
      }
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        SUBJECT_LITERAL_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SUBJECT_LITERAL_PATTERN.exec(line)) !== null) {
          const subject = match[1];
          if (subject === undefined) continue;
          // Templates often use a placeholder like "<therapist email>" or a Nunjucks
          // variable; only enforce on concrete addresses (something@something).
          if (!subject.includes('@')) continue;
          const key = `${rule.messageTemplate}:${subject}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!allowed.has(subject)) {
            findings.push({
              severity: 'error',
              rule: 'undeclared-impersonation-subject',
              message: `${rule.messageTemplate} uses subject \`${subject}\` in a tool_use block, but the IDENTITY.md security statement does not declare it under impersonation_subjects.`,
              path: rule.messageTemplate,
              line: i + 1,
              hint: `Add \`${subject}\` to impersonation_subjects in identity/IDENTITY.md, or remove the reference from the template if the subject is outside the trust boundary.`,
            });
          }
        }
      }
    }
  }
  return findings;
}

function checkMemoryNamespaces(config: AuditConfig, statement: IdentityStatement): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const declared = new Set(statement.memory_namespaces);
  const namespaceNames = new Set(Object.keys(config.memory?.namespaces ?? {}));

  for (const namespace of namespaceNames) {
    if (!declared.has(namespace)) {
      findings.push({
        severity: 'error',
        rule: 'undeclared-memory-namespace',
        message: `clawndom.yaml declares memory namespace \`${namespace}\` but the IDENTITY.md security statement does not list it under memory_namespaces.`,
        path: 'identity/IDENTITY.md',
        hint: `Add \`${namespace}\` to memory_namespaces, or remove it from clawndom.yaml if it's no longer in scope.`,
      });
    }
  }

  for (const namespace of declared) {
    if (!namespaceNames.has(namespace)) {
      findings.push({
        severity: 'warning',
        rule: 'stale-memory-namespace',
        message: `IDENTITY.md lists memory namespace \`${namespace}\` but clawndom.yaml does not declare it under memory.namespaces.`,
        path: 'identity/IDENTITY.md',
        hint: `Remove \`${namespace}\` from memory_namespaces, or add it to clawndom.yaml's memory.namespaces block if the agent still needs it.`,
      });
    }
  }

  return findings;
}

async function checkToolScopes(
  agentDir: string,
  config: AuditConfig,
  statement: IdentityStatement,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const declared = new Set(statement.tool_scopes.map((entry) => entry.tool));
  const referenced = new Set<string>();

  for (const routing of Object.values(config.routing)) {
    for (const rule of routing.rules) {
      for (const ref of rule.tools ?? []) {
        const module = (ref as { 'module.python'?: string })['module.python'];
        if (typeof module !== 'string') continue;
        const last = module.split('.').pop();
        if (last !== undefined) referenced.add(last);
      }
    }
  }

  for (const tool of referenced) {
    if (!declared.has(tool)) {
      findings.push({
        severity: 'warning',
        rule: 'undeclared-tool-scope',
        message: `Tool \`${tool}\` is declared on at least one route but IDENTITY.md tool_scopes does not list it. The agent has runtime access to a tool whose scope hasn't been attested.`,
        path: 'identity/IDENTITY.md',
        hint: `Add { tool: ${tool} } to tool_scopes (with notes describing the intended use), or remove the tool from clawndom.yaml if the agent shouldn't have it.`,
      });
    }
  }

  // Don't bother passing agentDir through if we never reference it.
  void agentDir;

  return findings;
}
