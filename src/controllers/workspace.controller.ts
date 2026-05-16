import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import type { Request, Response } from 'express';

import { auditAgent } from '../audit';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { buildContextSchemas } from '../services/context-schema.service';
import { getToolCatalog } from '../services/tool-catalog.service';

/**
 * GET /api/workspace/:agent
 *
 * Consolidated read endpoint for the editor UI. Returns everything
 * needed to render an agent's workspace in a single round-trip:
 *
 *   - `agent` / `dir` — identity + on-disk location.
 *   - `config` — the parsed `clawndom.yaml` (routing, modelRules,
 *     memory namespaces). Already in memory from boot; no re-parse.
 *   - `templates` — listing of `templates/*.md` files with byte sizes.
 *     Sizes drive a "this template is large/might be too long" hint
 *     in the inspector.
 *   - `tools` — the catalog subset this agent can drag onto a rule
 *     (same as `/api/agents/:agent/tools`).
 *   - `contextSchemas` — per-provider JSON Schemas describing the
 *     inbound payload shape rules can condition on (same as
 *     `/api/agents/:agent/context-schemas`).
 *
 * Three separate endpoints used to handle these; consolidating to one
 * cuts the UI's open-agent latency from 3-4 sequential requests to a
 * single fetch. The downstream endpoints remain in place — direct
 * callers and the audit wrapper still use them.
 */
export function createWorkspaceHandler(agents: readonly ResolvedAgent[]) {
  const byName = buildAgentIndex(agents);

  return async (request: Request, response: Response): Promise<void> => {
    const resolved = resolveAgent(byName, request, response);
    if (resolved === null) return;
    const { name, agent } = resolved;

    const templates = await listTemplates(agent.dir);
    const tools = getToolCatalog().listForAgent(name) ?? [];
    const contextSchemas = buildContextSchemas(agent);

    response.json({
      agent: name,
      dir: agent.dir,
      config: agent.config,
      templates,
      tools,
      contextSchemas: contextSchemas.providers,
    });
  };
}

/**
 * POST /api/workspace/:agent/audit
 *
 * Runs `auditAgent(agent.dir)` in-process (no shell-out) and returns
 * the full report as JSON. UI maps findings onto rule cards as inline
 * lint marks: each finding has a `rule` (check name), `severity`,
 * `path` (rule/template/dispatch reference), and `message`.
 *
 * POST (not GET) because the audit walks the filesystem and runs the
 * Python ast probe for tool-signature validation — semantically a
 * side-effect-free read but operationally expensive enough to justify
 * an explicit invocation verb. The UI invokes it on demand (Save,
 * "Re-audit" button, post-PR-merge refresh) rather than on every load.
 */
export function createWorkspaceAuditHandler(agents: readonly ResolvedAgent[]) {
  const byName = buildAgentIndex(agents);

  return async (request: Request, response: Response): Promise<void> => {
    const resolved = resolveAgent(byName, request, response);
    if (resolved === null) return;

    const report = await auditAgent(resolved.agent.dir);
    response.json(report);
  };
}

function buildAgentIndex(agents: readonly ResolvedAgent[]): ReadonlyMap<string, ResolvedAgent> {
  return new Map(agents.map((agent) => [agent.name, agent]));
}

function resolveAgent(
  byName: ReadonlyMap<string, ResolvedAgent>,
  request: Request,
  response: Response,
): { name: string; agent: ResolvedAgent } | null {
  const raw = request.params['agent'];
  const name = typeof raw === 'string' ? raw : '';
  if (name === '') {
    response.status(400).json({ error: 'agent path parameter is required' });
    return null;
  }
  const agent = byName.get(name);
  if (agent === undefined) {
    response.status(404).json({ error: `unknown agent: ${name}` });
    return null;
  }
  return { name, agent };
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const candidate: unknown = error.code;
  return typeof candidate === 'string' && candidate === code;
}

interface TemplateEntry {
  readonly path: string;
  readonly sizeBytes: number;
}

/**
 * GET /api/workspace/:agent/template/* — read a single template body.
 *
 * The trailing path is the relative path to the template under the
 * agent's workspace directory (e.g. `templates/inbox-triage.md`). Used
 * by the drag-and-drop editor UI to preview a template body when the
 * operator hovers / clicks one, without forcing the editor to load
 * every template up front via the listing endpoint.
 *
 * Returns `{ path, content, sizeBytes }` as JSON. Path-traversal is
 * blocked by resolving the candidate path and asserting it remains
 * under the agent's templates directory — an operator can't `../../`
 * their way out via this surface.
 */
export function createWorkspaceTemplateHandler(agents: readonly ResolvedAgent[]) {
  const byName = buildAgentIndex(agents);

  return async (request: Request, response: Response): Promise<void> => {
    const resolved = resolveAgent(byName, request, response);
    if (resolved === null) return;
    const { agent } = resolved;

    const rawPath = request.params['0'];
    if (typeof rawPath !== 'string' || rawPath === '') {
      response.status(400).json({ error: 'template path is required' });
      return;
    }

    const candidate = resolve(agent.dir, rawPath);
    const templatesRoot = resolve(agent.dir, 'templates');
    const relativePath = relative(templatesRoot, candidate);
    if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes('\0')) {
      response.status(400).json({ error: 'template path must resolve under templates/' });
      return;
    }
    if (!candidate.endsWith('.md') && !candidate.endsWith('.njk')) {
      response.status(400).json({ error: 'only .md and .njk templates are readable' });
      return;
    }

    try {
      const [content, info] = await Promise.all([readFile(candidate, 'utf8'), stat(candidate)]);
      response.json({
        path: `templates/${relativePath}`,
        content,
        sizeBytes: info.size,
      });
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
        response.status(404).json({ error: `template not found: templates/${relativePath}` });
        return;
      }
      throw error;
    }
  };
}

async function listTemplates(agentDir: string): Promise<readonly TemplateEntry[]> {
  const templatesDir = join(agentDir, 'templates');
  let entries: string[];
  try {
    entries = await readdir(templatesDir);
  } catch (error) {
    // No templates/ directory is valid (system agents, minimal
    // workspaces). Return empty rather than 500 — the UI handles
    // the empty case as a "no templates yet" surface.
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return [];
    throw error;
  }
  const stats = await Promise.all(
    entries
      .filter((name) => name.endsWith('.md') || name.endsWith('.njk'))
      .map(async (name) => {
        const path = join(templatesDir, name);
        const info = await stat(path);
        return {
          path: `templates/${name}`,
          sizeBytes: info.size,
        };
      }),
  );
  stats.sort((a, b) => a.path.localeCompare(b.path));
  return stats;
}
