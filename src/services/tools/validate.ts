import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ToolDescriptor } from './descriptor';

const execFile = promisify(execFileCallback);

/**
 * Boot-time signature validation. Catches YAML↔helper drift before any
 * agent invokes the tool. Python helpers are parsed via stdlib `ast` (no
 * import, no execution); bash helpers via leading header comments.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Boot-Time Signature Validation.
 */

export async function validateToolSignature(descriptor: ToolDescriptor): Promise<void> {
  if (descriptor.kind === 'python') {
    await validatePythonSignature(descriptor);
  } else {
    await validateBashSignature(descriptor);
  }
}

interface PythonSignature {
  /** Map of kwarg name → has signature default. */
  readonly kwargs: Record<string, boolean>;
}

/**
 * Extract the `invoke()` function's kwonly arguments from `impl.py` via
 * Python's stdlib `ast`. No module import, no top-level code execution.
 */
async function extractPythonSignature(implementationPath: string): Promise<PythonSignature> {
  const probe = `
import ast, json, sys
with open(${JSON.stringify(implementationPath)}) as f:
    tree = ast.parse(f.read(), filename=${JSON.stringify(implementationPath)})
fn = None
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == 'invoke':
        fn = node
        break
if fn is None:
    sys.exit("impl.py is missing a top-level 'invoke' function")
# We require kwonly args (def invoke(*, foo, bar): ...) so the dispatch can
# unpack from JSON unambiguously. Positional args are not supported.
if fn.args.args:
    sys.exit("invoke() must use keyword-only arguments (def invoke(*, ...))")
kwargs = {}
for arg, default in zip(fn.args.kwonlyargs, fn.args.kw_defaults):
    kwargs[arg.arg] = default is not None
print(json.dumps({"kwargs": kwargs}))
`.trim();
  let stdout: string;
  try {
    const result = await execFile('python3', ['-c', probe]);
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse impl.py at ${implementationPath}: ${message}`);
  }
  const parsed = JSON.parse(stdout) as PythonSignature;
  return parsed;
}

async function validatePythonSignature(descriptor: ToolDescriptor): Promise<void> {
  const implementationPath = join(descriptor.directory, 'impl.py');
  const signature = await extractPythonSignature(implementationPath);

  const sigKwargs = signature.kwargs;
  const expectedArgs = new Set(Object.keys(descriptor.args));
  const expectedRequires = new Set(descriptor.requires);
  const expected = new Set([...expectedArgs, ...expectedRequires]);

  const errors: string[] = [];

  // Every YAML arg must exist as a kwarg.
  for (const argumentName of expectedArgs) {
    if (!(argumentName in sigKwargs)) {
      errors.push(`tool.yaml declares arg '${argumentName}' but invoke() has no such kwarg`);
    }
  }
  // Every requires must exist as a kwarg.
  for (const requirementName of expectedRequires) {
    if (!(requirementName in sigKwargs)) {
      errors.push(`tool.yaml requires '${requirementName}' but invoke() has no such kwarg`);
    }
  }
  // Optional-ness in YAML must match has-default in signature.
  for (const [argumentName, argumentSpec] of Object.entries(descriptor.args)) {
    const sigHasDefault = sigKwargs[argumentName];
    if (sigHasDefault === undefined) continue; // Already reported above.
    if (argumentSpec.optional && !sigHasDefault) {
      errors.push(
        `arg '${argumentName}' is optional in tool.yaml but invoke() has no signature default`,
      );
    }
    if (!argumentSpec.optional && sigHasDefault) {
      errors.push(
        `arg '${argumentName}' is required in tool.yaml but invoke() has a signature default (silent optional)`,
      );
    }
  }
  // Requires MUST have no signature default — they're always passed by the executor.
  for (const requirementName of expectedRequires) {
    const sigHasDefault = sigKwargs[requirementName];
    if (sigHasDefault === true) {
      errors.push(
        `requires '${requirementName}' has a signature default in invoke(); credentials are always injected, no default allowed`,
      );
    }
  }
  // No extra kwargs in invoke() beyond args + requires.
  for (const kwargName of Object.keys(sigKwargs)) {
    if (!expected.has(kwargName)) {
      errors.push(
        `invoke() has extra kwarg '${kwargName}' not declared in tool.yaml args or requires`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Signature mismatch for tool '${descriptor.name}' at ${implementationPath}:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

interface BashHeader {
  readonly args: Set<string>;
  readonly optional: Set<string>;
  readonly requires: Set<string>;
}

/**
 * Parse the leading comment block of an `impl.sh` for `# Args:`,
 * `# Optional:`, and `# Requires-Env:` declarations. Each declaration is a
 * comma-separated list of identifier-style names.
 */
function parseBashHeader(contents: string): BashHeader {
  const args = new Set<string>();
  const optional = new Set<string>();
  const requires = new Set<string>();

  const lines = contents.split('\n');
  // Skip shebang if present, then scan leading comment block.
  let i = 0;
  if (lines[i]?.startsWith('#!')) i++;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (!line.startsWith('#')) break; // End of leading comment block.
    const stripped = line.replace(/^#\s*/, '');
    const argsMatch = /^Args:\s*(.+)$/i.exec(stripped);
    if (argsMatch?.[1] !== undefined) {
      for (const name of argsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        args.add(parseEnvVarName(name, 'ARG_'));
      }
      continue;
    }
    const optionalMatch = /^Optional:\s*(.+)$/i.exec(stripped);
    if (optionalMatch?.[1] !== undefined) {
      for (const name of optionalMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        optional.add(parseEnvVarName(name, 'ARG_'));
      }
      continue;
    }
    const requiresMatch = /^Requires-Env:\s*(.+)$/i.exec(stripped);
    if (requiresMatch?.[1] !== undefined) {
      for (const name of requiresMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        // descriptor.requires uses lowercase secret-names (e.g. slack_bot_token);
        // impl.sh header uses uppercase env-var form (SLACK_BOT_TOKEN). Normalize.
        requires.add(name.toLowerCase());
      }
    }
  }
  return { args, optional, requires };
}

function parseEnvVarName(name: string, prefix: string): string {
  // Header uses ARG_CHANNEL (env var form); descriptor uses 'channel' (lower).
  // Strip the prefix and lowercase for comparison.
  if (name.startsWith(prefix)) {
    return name.slice(prefix.length).toLowerCase();
  }
  return name.toLowerCase();
}

async function validateBashSignature(descriptor: ToolDescriptor): Promise<void> {
  const implementationPath = join(descriptor.directory, 'impl.sh');
  let contents: string;
  try {
    contents = await readFile(implementationPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing or unreadable impl.sh at ${implementationPath}: ${message}`);
  }

  const header = parseBashHeader(contents);
  const expectedArgs = new Set(Object.keys(descriptor.args).map((s) => s.toLowerCase()));
  const expectedRequires = new Set(descriptor.requires.map((s) => s.toLowerCase()));
  const expectedOptional = new Set(
    Object.entries(descriptor.args)
      .filter(([, spec]) => spec.optional)
      .map(([k]) => k.toLowerCase()),
  );

  const errors: string[] = [];

  for (const argumentName of expectedArgs) {
    if (!header.args.has(argumentName)) {
      errors.push(
        `tool.yaml declares arg '${argumentName}' but impl.sh '# Args:' header omits ARG_${argumentName.toUpperCase()}`,
      );
    }
  }
  for (const argumentName of header.args) {
    if (!expectedArgs.has(argumentName)) {
      errors.push(
        `impl.sh '# Args:' lists ARG_${argumentName.toUpperCase()} but tool.yaml has no such arg`,
      );
    }
  }
  for (const optName of expectedOptional) {
    if (!header.optional.has(optName)) {
      errors.push(
        `arg '${optName}' is optional in tool.yaml but impl.sh '# Optional:' header omits ARG_${optName.toUpperCase()}`,
      );
    }
  }
  for (const optName of header.optional) {
    if (!expectedOptional.has(optName)) {
      errors.push(
        `impl.sh '# Optional:' lists ARG_${optName.toUpperCase()} but tool.yaml doesn't mark '${optName}' as optional`,
      );
    }
  }
  for (const requirementName of expectedRequires) {
    if (!header.requires.has(requirementName)) {
      errors.push(
        `tool.yaml requires '${requirementName}' but impl.sh '# Requires-Env:' header omits ${requirementName.toUpperCase()}`,
      );
    }
  }
  for (const requirementName of header.requires) {
    if (!expectedRequires.has(requirementName)) {
      errors.push(
        `impl.sh '# Requires-Env:' lists ${requirementName.toUpperCase()} but tool.yaml doesn't require it`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Signature mismatch for tool '${descriptor.name}' at ${implementationPath}:\n  - ${errors.join('\n  - ')}`,
    );
  }
}
