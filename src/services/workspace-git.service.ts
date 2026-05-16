import { execFile as execFileCallback } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * PR-style write flow for the editor UI. The controller computes the
 * post-edit YAML in-process (see `workspace-edit.service.ts`); this
 * service is the I/O side — branch, commit, push, open PR.
 *
 * Two implementations:
 *
 *   - `RealGitOps` shells out to `git` and `gh`. Authoring identity is
 *     supplied per-call via `-c user.email` / `-c user.name` flags so
 *     the repo's git config never has to be mutated (per CLAUDE.md,
 *     "NEVER update the git config"). `gh` reads `GH_TOKEN` /
 *     `GITHUB_TOKEN` from the process environment.
 *
 *   - Test code injects a fake implementation that records calls and
 *     returns canned PR metadata. This is how the controller-level
 *     tests verify orchestration without a real repo.
 *
 * Errors propagate as plain Error with the failing argv joined into
 * the message — the controller maps them to a 500 with the message
 * surfaced so the UI can show "git push failed: ..." instead of an
 * opaque "internal server error".
 */
export interface ProposeEditArgs {
  /** Absolute path to the on-disk git repository root. */
  readonly repoDir: string;
  /** Absolute path to the file being rewritten (must live under repoDir). */
  readonly filePath: string;
  /** Post-edit file contents (written verbatim). */
  readonly newContent: string;
  /** Branch name to create off the repo's default branch. */
  readonly branchName: string;
  /** Base branch to PR against (typically `main`). */
  readonly baseBranch: string;
  /** Commit subject. Also used as PR title if no overriding PR title is set. */
  readonly commitMessage: string;
  /** PR body (markdown). */
  readonly prBody: string;
  /** Author identity for the commit (e.g. `sc0red-patch[bot]`). */
  readonly authorEmail: string;
  readonly authorName: string;
}

export interface ProposeEditResult {
  readonly prUrl: string;
  readonly prNumber: number;
  readonly branchName: string;
  readonly headSha: string;
}

export interface GitOps {
  proposeEdit(args: ProposeEditArgs): Promise<ProposeEditResult>;
}

export class RealGitOps implements GitOps {
  async proposeEdit(args: ProposeEditArgs): Promise<ProposeEditResult> {
    const {
      repoDir,
      filePath,
      newContent,
      branchName,
      baseBranch,
      commitMessage,
      prBody,
      authorEmail,
      authorName,
    } = args;

    await runGit(repoDir, ['fetch', 'origin', baseBranch]);
    await runGit(repoDir, ['switch', '-c', branchName, `origin/${baseBranch}`]);

    await writeFile(filePath, newContent, 'utf8');

    await runGit(repoDir, ['add', '--', filePath]);
    await runGit(repoDir, [
      '-c',
      `user.email=${authorEmail}`,
      '-c',
      `user.name=${authorName}`,
      'commit',
      '-m',
      commitMessage,
    ]);
    const headSha = (await runGit(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await runGit(repoDir, ['push', '-u', 'origin', branchName]);

    const prCreate = await runGh(repoDir, [
      'pr',
      'create',
      '--base',
      baseBranch,
      '--head',
      branchName,
      '--title',
      commitMessage,
      '--body',
      prBody,
    ]);
    const prUrl = prCreate.stdout.trim();
    const prNumber = parsePrNumberFromUrl(prUrl);

    return { prUrl, prNumber, branchName, headSha };
  }
}

async function runGit(
  repoDir: string,
  argv: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return runCommand('git', ['-C', repoDir, ...argv]);
}

async function runGh(
  repoDir: string,
  argv: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return runCommand('gh', argv, { cwd: repoDir });
}

async function runCommand(
  command: string,
  argv: readonly string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(command, [...argv], options);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${command} ${argv.join(' ')} failed: ${error.message}`);
    }
    throw error;
  }
}

function parsePrNumberFromUrl(prUrl: string): number {
  const captured = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (captured === undefined) {
    throw new Error(`could not parse PR number from gh output: ${prUrl}`);
  }
  return Number.parseInt(captured, 10);
}
