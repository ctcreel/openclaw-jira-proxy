import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * Doc-injection scan utilities.
 *
 * Templates embed reference docs via four Nunjucks-extension tags:
 *
 *   {{doc:<rel>}}            — agent-workspace-relative body injection
 *   {{system-doc:<rel>}}     — same path, into the cacheable system slot
 *   {{shared:<rel>}}         — workspaces/shared-relative body injection
 *   {{system-shared:<rel>}}  — same path, system slot
 *
 * Audit checks need to know: for a given template, which targets it references,
 * where each resolves on disk, and what's inside the resolved file (so we can
 * recurse for literal-`{{` checks).
 */

export type InjectionKind = 'doc' | 'system-doc' | 'shared' | 'system-shared';

export interface InjectionRef {
  readonly kind: InjectionKind;
  /** The raw path inside the `{{...}}` tag, e.g. `docs/IDENTITY.md`. */
  readonly target: string;
  /** 1-indexed line of the source file where the tag appears. */
  readonly line: number;
}

const INJECTION_REGEX = /\{\{(system-doc|system-shared|doc|shared):\s*([^}\s]+?)\s*\}\}/g;

export function findInjections(source: string): InjectionRef[] {
  const refs: InjectionRef[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    INJECTION_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INJECTION_REGEX.exec(line)) !== null) {
      const kind = match[1] as InjectionKind;
      const target = match[2];
      if (target === undefined) continue;
      refs.push({ kind, target, line: i + 1 });
    }
  }
  return refs;
}

export interface InjectionResolution {
  /** Absolute filesystem path the injection resolves to. */
  readonly absolutePath: string;
  /** Path relative to the agentDir or sharedDir (for display). */
  readonly displayPath: string;
  readonly exists: boolean;
}

export interface ResolveContext {
  /** The agent workspace root (contains clawndom.yaml). */
  readonly agentDir: string;
  /** Optional sibling workspaces/shared directory for {{shared:...}} resolution. */
  readonly sharedDir?: string;
}

export function resolveInjection(ref: InjectionRef, ctx: ResolveContext): InjectionResolution {
  const baseDir =
    ref.kind === 'shared' || ref.kind === 'system-shared' ? ctx.sharedDir : ctx.agentDir;
  if (baseDir === undefined) {
    return {
      absolutePath: ref.target,
      displayPath: ref.target,
      exists: false,
    };
  }
  const absolutePath = resolve(baseDir, ref.target);
  const displayPath = relative(ctx.agentDir, absolutePath) || ref.target;
  return {
    absolutePath,
    displayPath,
    exists: existsSync(absolutePath),
  };
}

/**
 * Recursively walk a template's injections and any nested injections inside the
 * resolved files. Cycles are broken by tracking visited absolute paths. Used by
 * the literal-`{{` check, which must read every doc that ends up rendered.
 */
export async function walkInjections(
  rootSource: string,
  ctx: ResolveContext,
): Promise<{ path: string; source: string; injection: InjectionRef }[]> {
  const visited = new Set<string>();
  const results: { path: string; source: string; injection: InjectionRef }[] = [];

  async function recurse(source: string): Promise<void> {
    const refs = findInjections(source);
    for (const ref of refs) {
      const resolution = resolveInjection(ref, ctx);
      if (!resolution.exists) continue;
      if (visited.has(resolution.absolutePath)) continue;
      visited.add(resolution.absolutePath);
      const nested = await readFile(resolution.absolutePath, 'utf-8');
      results.push({ path: resolution.displayPath, source: nested, injection: ref });
      await recurse(nested);
    }
  }

  await recurse(rootSource);
  return results;
}

export function autoDetectSharedDir(agentDir: string): string | undefined {
  // Multi-agent layout: <repoRoot>/workspaces/<agent>/ → sibling shared/
  const sharedCandidate = resolve(dirname(agentDir), 'shared');
  if (existsSync(sharedCandidate)) {
    return sharedCandidate;
  }
  return undefined;
}
