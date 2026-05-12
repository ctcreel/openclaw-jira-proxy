import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ToolDescriptor } from './descriptor';
import { pythonBinary } from './executor';

const execFile = promisify(execFileCallback);

/**
 * Boot-time signature validation. Catches YAML↔helper drift before any
 * agent invokes the tool. Python helpers are parsed via stdlib `ast` (no
 * import, no top-level code execution).
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Boot-Time Signature Validation.
 */
export async function validateToolSignature(descriptor: ToolDescriptor): Promise<void> {
  const implementationPath = join(descriptor.directory, 'impl.py');
  const signature = await extractPythonSignature(implementationPath);

  const sigKwargs = signature.kwargs;
  const expectedArgs = new Set(Object.keys(descriptor.args));
  const expectedSecrets = new Set(descriptor.secrets.map((s) => s.canonical));
  const expected = new Set([...expectedArgs, ...expectedSecrets]);

  const errors: string[] = [];

  // Every YAML arg must exist as a kwarg.
  for (const argumentName of expectedArgs) {
    if (!(argumentName in sigKwargs)) {
      errors.push(`tool.yaml declares arg '${argumentName}' but invoke() has no such kwarg`);
    }
  }
  // Every secret's canonical name must exist as a kwarg.
  for (const secretName of expectedSecrets) {
    if (!(secretName in sigKwargs)) {
      errors.push(`tool.yaml declares secret '${secretName}' but invoke() has no such kwarg`);
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
  // Secrets MUST have no signature default — they're always passed by the executor.
  for (const secretName of expectedSecrets) {
    const sigHasDefault = sigKwargs[secretName];
    if (sigHasDefault === true) {
      errors.push(
        `secret '${secretName}' has a signature default in invoke(); credentials are always injected, no default allowed`,
      );
    }
  }
  // No extra kwargs in invoke() beyond args + secrets.
  for (const kwargName of Object.keys(sigKwargs)) {
    if (!expected.has(kwargName)) {
      errors.push(
        `invoke() has extra kwarg '${kwargName}' not declared in tool.yaml args or secrets`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Signature mismatch for tool '${descriptor.name}' at ${implementationPath}:\n  - ${errors.join('\n  - ')}`,
    );
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
    const result = await execFile(pythonBinary(), ['-c', probe]);
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse impl.py at ${implementationPath}: ${message}`);
  }
  const parsed = JSON.parse(stdout) as PythonSignature;
  return parsed;
}
