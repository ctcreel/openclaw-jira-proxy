import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '../logging';
import type { ToolEntry } from './frontmatter';

const logger = getLogger('tool-block');

/**
 * Resolve the path to the Python introspector script. We can't `require` a
 * `.py` asset, so the script ships alongside this `.ts` file and the path is
 * derived from `import.meta.url`. tsup copies the script into `dist/` (see
 * `tsup.config.ts`) so the production build works the same way.
 */
const introspectorPath = resolve(dirname(fileURLToPath(import.meta.url)), 'tools-introspect.py');

interface IntrospectionFailure {
  readonly ok: false;
  readonly error: string;
}

interface IntrospectionSuccess {
  readonly ok: true;
  readonly doc: string;
  readonly callables: ReadonlyArray<{
    readonly name: string;
    readonly signature: string;
    readonly doc: string;
  }>;
}

type IntrospectionResult = IntrospectionFailure | IntrospectionSuccess;

interface IntrospectorResponse {
  readonly [module: string]: IntrospectionResult;
}

const INTROSPECTOR_TIMEOUT_MS = 30_000;

/**
 * Run the Python introspector against `agencyToolsPath` (used as
 * `PYTHONPATH`). Short-lived, pure-stdio subprocess: no shell, no file
 * writes, no network. `python3` not on PATH surfaces as a thrown Error
 * naming the missing binary — never a silent empty render.
 *
 * Implemented via `spawn` (rather than `execFile`) so we can pipe the
 * request to stdin without depending on the un-typed `input` option that
 * landed in Node 18 but never made it into `@types/node`'s `execFile`
 * overloads.
 */
async function invokeIntrospector(
  modules: readonly string[],
  agencyToolsPath: string,
): Promise<IntrospectorResponse> {
  if (modules.length === 0) return {};

  return new Promise<IntrospectorResponse>((resolvePromise, rejectPromise) => {
    const child = spawn('python3', [introspectorPath], {
      env: { ...process.env, PYTHONPATH: agencyToolsPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, INTROSPECTOR_TIMEOUT_MS);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === 'ENOENT') {
        rejectPromise(
          new Error(
            '`python3` is not on PATH. Install Python 3 or remove `tools:` declarations ' +
              'from every template before starting clawndom.',
          ),
        );
        return;
      }
      rejectPromise(new Error(`Tool introspection subprocess failed: ${error.message}`));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(
          new Error(`Tool introspection subprocess timed out after ${INTROSPECTOR_TIMEOUT_MS}ms`),
        );
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Tool introspection subprocess exited with code ${code ?? 'null'}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as IntrospectorResponse);
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        rejectPromise(
          new Error(`Tool introspection produced non-JSON stdout: ${message}\nstdout: ${stdout}`),
        );
      }
    });

    child.stdin.end(JSON.stringify({ modules }));
  });
}

/**
 * Render one module's introspection result into a Markdown block. The exact
 * shape is the renderer's contract with the prompt cache: it must be
 * deterministic across runs (no timestamps, no random order, no payload
 * interpolation) and stable across different agent runs of the same
 * template. The byte-stability regression test in
 * `tests/lib/template/render-tool-block.test.ts` enforces both.
 *
 * The invocation example uses the heredoc idiom (`bash <<'PY' … PY`) that
 * Patch templates already use for Python helpers — keeping the rendered docs
 * close to the existing call sites lowers the cost of switching idioms in
 * either direction.
 */
function renderModuleBlock(
  dotted: string,
  result: IntrospectionResult,
  requiresEnv: readonly string[],
): string {
  if (!result.ok) {
    // Boot validation should have caught this — but if introspection drifts
    // post-boot (e.g. agency-tools clone churned mid-process), we surface
    // the failure inline so it's visible to the operator AND to the agent
    // rather than silently rendering nothing.
    return [`## ${dotted}`, '', `**Introspection failed:** \`${result.error}\``, ''].join('\n');
  }

  const lines: string[] = [];
  lines.push(`## ${dotted}`);
  lines.push('');
  if (result.doc.length > 0) {
    lines.push(result.doc);
    lines.push('');
  }
  for (const fn of result.callables) {
    lines.push(`### \`${fn.signature}\``);
    lines.push('');
    if (fn.doc.length > 0) {
      lines.push(fn.doc);
      lines.push('');
    }
    lines.push('```bash');
    lines.push(`bash <<'PY'`);
    lines.push('import os');
    lines.push(`from ${dotted} import ${fn.name}`);
    if (requiresEnv.length === 1) {
      lines.push(`# Provide ${requiresEnv[0]} via the matching SECRETS_CONFIG entry.`);
    } else if (requiresEnv.length > 1) {
      const list = requiresEnv.join(', ');
      lines.push(`# Provide ${list} via matching SECRETS_CONFIG entries.`);
    }
    if (requiresEnv.length === 0) {
      lines.push(`${fn.name}()`);
    } else if (requiresEnv.length === 1) {
      const envName = requiresEnv[0]!;
      lines.push(`${fn.name}(bot_token=os.environ['${envName}'])`);
    } else {
      // Multi-env helpers are rare today; render an explicit reminder
      // instead of guessing keyword names. Authors can edit the example
      // template-side if they need a more specific call.
      const envNames = requiresEnv.map((name) => `os.environ['${name}']`).join(', ');
      lines.push(`# Required env: ${envNames}`);
      lines.push(`${fn.name}(...)`);
    }
    lines.push('PY');
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Module-level cache of fully rendered tool blocks. Key composition:
 * `<frontmatterContentHash>::<agencyToolsPath>`. Frontmatter content captures
 * "which tools, in what order, with what env"; the path captures "which
 * agency-tools clone the introspector saw." A live operator reload that
 * swaps the agency-tools clone in place needs a clawndom restart to take
 * effect — same constraint that already applies to every other piece of
 * agent config (see `loadAgents` in `agent-loader.service.ts`).
 *
 * Cleared by `__clearToolBlockCache` in tests via `resetToolBlockCache`. No
 * production code path clears it: the cache is per-process and the process
 * lifetime is the unit of staleness.
 */
const renderedBlockCache = new Map<string, string>();

export function resetToolBlockCache(): void {
  renderedBlockCache.clear();
}

/**
 * Render the canonical Markdown block for a template's `tools:` manifest.
 * Returns the empty string when no tools are declared — callers don't
 * special-case the no-tools path.
 *
 * The rendered block is cached on (frontmatterContentHash, agencyToolsPath).
 * Two events for the same template hit the cache and skip the Python
 * subprocess entirely; that's what keeps the per-event hot path cheap.
 */
export async function renderToolBlock(args: {
  readonly tools: readonly ToolEntry[];
  readonly agencyToolsPath: string;
  readonly rawFrontmatter: string;
}): Promise<string> {
  const { tools, agencyToolsPath, rawFrontmatter } = args;
  if (tools.length === 0) {
    return '';
  }

  const frontmatterHash = createHash('sha256').update(rawFrontmatter).digest('hex').slice(0, 16);
  const cacheKey = `${frontmatterHash}::${agencyToolsPath}`;

  const cached = renderedBlockCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const moduleNames = tools.map((t) => t.module);
  const introspections = await invokeIntrospector(moduleNames, agencyToolsPath);

  const blocks: string[] = [];
  for (const tool of tools) {
    const result = introspections[tool.module];
    if (result === undefined) {
      // Defensive: the Python script returns a result entry per requested
      // module. If a module is missing from the response we surface the
      // discrepancy rather than silently rendering nothing.
      throw new Error(
        `Introspector returned no entry for module "${tool.module}". ` +
          'Stale subprocess or schema drift between Node and Python sides.',
      );
    }
    blocks.push(renderModuleBlock(tool.module, result, tool.requires_env));
  }

  const rendered = blocks.join('\n');
  renderedBlockCache.set(cacheKey, rendered);
  logger.debug(
    {
      modules: moduleNames,
      cacheKey,
      bytes: rendered.length,
    },
    'Rendered tool block (cache miss)',
  );
  return rendered;
}

/**
 * Validate that every module in `modules` imports cleanly under the given
 * `agencyToolsPath`. Used by boot validation to fail fast with a clear
 * message if a `tools:` declaration references a missing module.
 */
export async function validateToolModulesImport(
  modules: readonly string[],
  agencyToolsPath: string,
): Promise<void> {
  if (modules.length === 0) return;
  const introspections = await invokeIntrospector(modules, agencyToolsPath);
  const failures: string[] = [];
  for (const dotted of modules) {
    const result = introspections[dotted];
    if (result === undefined) {
      failures.push(`${dotted}: no result returned by introspector`);
    } else if (!result.ok) {
      failures.push(`${dotted}: ${result.error}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Template tool modules failed to import: ${failures.join('; ')}`);
  }
}

// Re-exported as types so tests can construct fixtures and assert shapes
// without spawning Python.
export type { IntrospectionResult, IntrospectorResponse };
// Exposed for scripts and tests that want to inspect modules without going
// through the renderer cache.
export { invokeIntrospector };
