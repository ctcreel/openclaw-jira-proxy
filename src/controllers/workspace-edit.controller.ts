import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Request, Response } from 'express';

import type { ResolvedAgent } from '../services/agent-loader.service';
import {
  editPayloadSchema,
  processEdits,
  type EditPayload,
} from '../services/workspace-edit.service';
import type { GitOps } from '../services/workspace-git.service';

const execFile = promisify(execFileCallback);

/**
 * POST /api/workspace/:agent/edit
 *
 * Editor-UI write flow. The UI sends a small list of high-level
 * operations on `clawndom.yaml` (rule.add/update/delete), the
 * controller runs them through the AST applier (so multi-paragraph
 * decision comments survive), writes the new file, and opens a PR.
 *
 * Pattern:
 *   1. Resolve the agent by name.
 *   2. Zod-parse the body — fail-fast on invalid op shapes before any
 *      filesystem work.
 *   3. Read the current `clawndom.yaml`, run `processEdits`, get back
 *      the post-edit YAML + the parsed config.
 *   4. Compute the repo root (the file lives somewhere under it), pick
 *      a branch name, build a PR title and body from the operator's
 *      `message` + `description`.
 *   5. Hand off to `GitOps.proposeEdit` — writes the file, commits as
 *      the configured bot identity, pushes, opens a PR via `gh`.
 *   6. Respond with the PR URL + number + branch + head sha so the UI
 *      can deep-link the operator and poll for CI status.
 *
 * Errors out of `processEdits` (collision, unknown rule, post-edit
 * schema failure) come back as 400 because they reflect a request the
 * UI shouldn't have sent. Errors out of `GitOps` come back as 500 with
 * the failing argv preserved in `error` so the UI can surface "git
 * push failed: ..." instead of an opaque "internal server error".
 */
export interface WorkspaceEditConfig {
  /** Default base branch for opened PRs. Typically `main`. */
  readonly baseBranch: string;
  /** Identity the commit will be authored as. */
  readonly authorEmail: string;
  readonly authorName: string;
  /** Branch-name prefix; pattern: `<prefix>/<agent>/<short-sha>`. */
  readonly branchNamePrefix: string;
}

export function createWorkspaceEditHandler(
  agents: readonly ResolvedAgent[],
  gitOps: GitOps,
  config: WorkspaceEditConfig,
) {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));

  return async (request: Request, response: Response): Promise<void> => {
    const raw = request.params['agent'];
    const name = typeof raw === 'string' ? raw : '';
    if (name === '') {
      response.status(400).json({ error: 'agent path parameter is required' });
      return;
    }
    const agent = byName.get(name);
    if (agent === undefined) {
      response.status(404).json({ error: `unknown agent: ${name}` });
      return;
    }

    const parsed = editPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'invalid edit payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const result = await runWriteFlow(agent, parsed.data, gitOps, config);
      response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = classifyError(message);
      response.status(status).json({ error: message });
    }
  };
}

async function runWriteFlow(
  agent: ResolvedAgent,
  payload: EditPayload,
  gitOps: GitOps,
  config: WorkspaceEditConfig,
): Promise<{
  prUrl: string;
  prNumber: number;
  branchName: string;
  headSha: string;
}> {
  const filePath = join(agent.dir, 'clawndom.yaml');
  const currentYaml = await readFile(filePath, 'utf8');
  const { yaml: newContent } = processEdits(currentYaml, payload);

  const repoDir = await findRepoRoot(agent.dir);
  const branchName = buildBranchName(config.branchNamePrefix, agent.name);
  const prBody = buildPrBody(payload);

  return gitOps.proposeEdit({
    repoDir,
    filePath,
    newContent,
    branchName,
    baseBranch: config.baseBranch,
    commitMessage: payload.message,
    prBody,
    authorEmail: config.authorEmail,
    authorName: config.authorName,
  });
}

async function findRepoRoot(dir: string): Promise<string> {
  const { stdout } = await execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return stdout.trim();
}

function buildBranchName(prefix: string, agentName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${prefix}/${agentName}/${stamp}`;
}

function buildPrBody(payload: EditPayload): string {
  const summary = payload.description.trim();
  const opsList = payload.edits
    .map((op) => {
      if (op.op === 'rule.add') {
        const ruleName = typeof op.rule['name'] === 'string' ? op.rule['name'] : '<unnamed>';
        return `- \`rule.add\` ${op.provider}/${ruleName}`;
      }
      if (op.op === 'rule.move') {
        return `- \`rule.move\` ${op.provider}/${op.ruleName} → index ${op.toIndex}`;
      }
      return `- \`${op.op}\` ${op.provider}/${op.ruleName}`;
    })
    .join('\n');
  const header = summary === '' ? '## Changes' : `${summary}\n\n## Changes`;
  return `${header}\n\n${opsList}\n`;
}

function classifyError(message: string): number {
  // `processEdits` throws on UI-out-of-date scenarios and schema failure.
  // These are 400s — the operator's request needs revising.
  if (
    message.includes('already exists') ||
    message.includes('not found') ||
    message.includes('Post-edit config failed validation') ||
    message.includes('YAML parse errors')
  ) {
    return 400;
  }
  return 500;
}
