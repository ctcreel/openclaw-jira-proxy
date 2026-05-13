import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

/**
 * IDENTITY.md security-statement front-matter.
 *
 * Every agent's `identity/IDENTITY.md` carries a YAML front-matter block
 * declaring the trust boundary: which service account it runs as, which
 * DWD subjects it may impersonate, which memory namespaces it touches,
 * which tools may carry which parameter ranges. The prose body below the
 * front-matter remains the human/model-facing identity description; the
 * front-matter is the machine-checkable attestation.
 *
 * Field semantics:
 *
 * - `runs_as` — the canonical authoring identity (e.g. service-account
 *   email, agent Atlassian accountId). Operator-config (not enforced by
 *   the runtime) but auditable.
 * - `impersonation_subjects` — DWD subjects the agent is permitted to
 *   pass as the `subject:` argument to any tool. Anything else is a
 *   trust-boundary violation. The audit cross-checks this against
 *   `subject:` literals appearing in template tool_use blocks.
 * - `external_recipients` — declared list of outside-domain addresses
 *   the agent is permitted to send mail to (escalation CCs, etc.). An
 *   empty list means internal-only.
 * - `memory_namespaces` — namespaces the agent may read or write. Audit
 *   cross-checks against clawndom.yaml's `memory.namespaces` block.
 * - `tool_scopes` — per-tool parameter constraints. Today only declares
 *   that a tool exists in the agent's scope; future iterations narrow
 *   acceptable argument ranges.
 */
export const identityStatementSchema = z.object({
  runs_as: z.string().min(1),
  impersonation_subjects: z.array(z.string().min(1)).default([]),
  external_recipients: z.array(z.string().min(1)).default([]),
  memory_namespaces: z.array(z.string().min(1)).default([]),
  tool_scopes: z
    .array(
      z.object({
        tool: z.string().min(1),
        notes: z.string().optional(),
      }),
    )
    .default([]),
});

export type IdentityStatement = z.infer<typeof identityStatementSchema>;

export interface LoadedIdentity {
  readonly statement: IdentityStatement;
  readonly prose: string;
  readonly path: string;
}

const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function findIdentityPath(agentDir: string): string | undefined {
  const candidate = join(agentDir, 'identity', 'IDENTITY.md');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Parse IDENTITY.md into front-matter (security statement) + prose body.
 * Returns null when the file has no front-matter — callers decide whether
 * that's a hard error or a warning depending on the call site.
 */
export async function loadIdentityStatement(identityPath: string): Promise<LoadedIdentity | null> {
  const raw = await readFile(identityPath, 'utf-8');
  const match = FRONT_MATTER_PATTERN.exec(raw);
  if (match === null) return null;
  const frontMatterYaml = match[1] ?? '';
  const prose = match[2] ?? '';
  const parsed = parseYaml(frontMatterYaml);
  const statement = identityStatementSchema.parse(parsed);
  return { statement, prose, path: identityPath };
}
