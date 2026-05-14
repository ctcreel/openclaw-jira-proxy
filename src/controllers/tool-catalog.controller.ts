import type { Request, Response } from 'express';

import { getToolCatalog } from '../services/tool-catalog.service';

/**
 * GET /api/tools/catalog
 *
 * Every tool the runtime knows about, aggregated across every loaded
 * agent. Each entry carries the parsed `tool.yaml` shape: name,
 * dotted reference, description, args (typed), and secrets contract
 * (canonical name + aliases — no resolved values).
 *
 * Editor UI uses this as the palette source.
 */
export function listToolCatalog(_request: Request, response: Response): void {
  response.json({ tools: getToolCatalog().list() });
}

/**
 * GET /api/agents/:agent/tools
 *
 * The subset of the catalog this specific agent has bindings for. The
 * editor uses this to filter "tools you can actually drag onto a rule
 * in this agent's clawndom.yaml" — dragging xero_create_invoice onto a
 * Patch rule is structurally invalid because Patch's agency-tools clone
 * doesn't expose it.
 *
 * 404 when the agent name isn't loaded.
 */
export function listAgentTools(request: Request, response: Response): void {
  const raw = request.params['agent'];
  const agent = typeof raw === 'string' ? raw : '';
  if (agent === '') {
    response.status(400).json({ error: 'agent path parameter is required' });
    return;
  }
  const tools = getToolCatalog().listForAgent(agent);
  if (tools === undefined) {
    response.status(404).json({ error: `unknown agent: ${agent}` });
    return;
  }
  response.json({ agent, tools });
}
