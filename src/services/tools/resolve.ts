import { existsSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getToolKind, getToolReference, type ToolRef } from './config-schemas';

const execFile = promisify(execFileCallback);

/**
 * Resolve a tool's directory on disk from its route-declared reference.
 *
 * For `module.python:` references, the top-level package is located via
 * Python's import machinery (a short `python3 -c` invocation runs
 * `importlib.util.find_spec(...)`); remaining dotted segments are joined as
 * subdirectories. For `module.bash:` references, the entire dotted path
 * resolves relative to the agent's workspace directory.
 *
 * The returned path is the leaf directory that MUST contain `tool.yaml`. The
 * caller is responsible for validating the presence of `tool.yaml` and the
 * appropriate `impl.{py,sh}` file.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Tool Directory Layout.
 */
export async function resolveToolDirectory(ref: ToolRef, agentDir: string): Promise<string> {
  const kind = getToolKind(ref);
  const dotted = getToolReference(ref);
  const segments = dotted.split('.');

  if (kind === 'bash') {
    const dir = join(agentDir, ...segments);
    if (!existsSync(dir)) {
      throw new Error(`Bash tool directory not found for reference '${dotted}': expected ${dir}`);
    }
    return dir;
  }

  // Python: locate the top-level package via importlib, then append segments.
  // The dotted reference is regex-validated upstream (see config-schemas.ts),
  // so `segments` always has at least one non-empty entry by the time we get
  // here — no defensive `topLevel === undefined` check needed.
  const [topLevel, ...rest] = segments as [string, ...string[]];
  const packageDir = await locatePythonPackage(topLevel, agentDir);
  const dir = join(packageDir, ...rest);
  if (!existsSync(dir)) {
    throw new Error(
      `Python tool directory not found for reference '${dotted}': expected ${dir} (package '${topLevel}' resolved to ${packageDir})`,
    );
  }
  return dir;
}

/**
 * Return the on-disk directory of a top-level Python package by asking
 * Python's importlib. The agent's workspace directory is prepended to
 * PYTHONPATH so workspace-local packages (e.g. winston_agent installed
 * editable from the workspace) resolve alongside venv-installed packages.
 *
 * Throws if the package is not importable from the venv Clawndom invokes.
 */
async function locatePythonPackage(packageName: string, agentDir: string): Promise<string> {
  const probe = `
import importlib.util
import sys
spec = importlib.util.find_spec(${JSON.stringify(packageName)})
if spec is None or not spec.submodule_search_locations:
    sys.exit("not-a-package")
print(list(spec.submodule_search_locations)[0])
`.trim();

  const env = { ...process.env };
  // Prepend agentDir so workspace-local Python packages resolve.
  const existingPath = env['PYTHONPATH'];
  env['PYTHONPATH'] = existingPath !== undefined ? `${agentDir}:${existingPath}` : agentDir;

  try {
    const { stdout } = await execFile('python3', ['-c', probe], { env });
    return stdout.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to locate Python package '${packageName}' (from agentDir=${agentDir}): ${msg}`,
    );
  }
}
