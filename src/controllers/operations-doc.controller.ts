import type { Request, Response } from 'express';

import type { ResolvedAgent } from '../services/agent-loader.service';
import { renderOperationsDoc } from '../services/operations-doc.service';

/**
 * GET /api/agents/:agent/operations.md
 *
 * Renders a per-agent operations runbook as Markdown derived from
 * Clawndom's live state (parsed `clawndom.yaml`, cached agent_version,
 * runtime settings). Intended caller: a GitHub Action in each agent-
 * workspace repo that regenerates `OPERATIONS.md` on push-to-main
 * and commits the result back via `sc0red-patch[bot]`.
 *
 * Returns `text/markdown; charset=utf-8` so curl-and-redirect Just
 * Works in the GH Action. Path is reachable through the
 * Tailscale-identity middleware on the editor mount.
 */
export function createOperationsDocHandler(agents: readonly ResolvedAgent[]) {
  const byName = new Map(agents.map((a) => [a.name, a] as const));
  return (request: Request, response: Response): void => {
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
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    response.send(renderOperationsDoc(agent));
  };
}
