import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * Capture the git SHA and dirty state of a single repository path.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-versioning/spec.md`.
 */
export interface RepoVersion {
  readonly sha: string;
  readonly dirty: boolean;
}

export async function captureRepoVersion(repoPath: string): Promise<RepoVersion> {
  const sha = await runGit(['-C', repoPath, 'rev-parse', 'HEAD']);
  const status = await runGit(['-C', repoPath, 'status', '--porcelain']);
  return { sha: sha.trim(), dirty: status.trim().length > 0 };
}

async function runGit(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', [...args]);
    return stdout;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${msg}`);
  }
}
