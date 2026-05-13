import type { Request, Response } from 'express';

import type { ResolvedAgent } from '../services/agent-loader.service';
import { buildContextSchemas } from '../services/context-schema.service';

/**
 * GET /api/agents/:agent/context-schemas
 *
 * Returns `{agent, providers: {<providerName>: <JSON Schema>}}`. Each
 * provider schema describes the inbound payload shape rules under that
 * provider can condition on. Editor condition-builder UIs drive
 * typeahead from this — drilling `issue.fields.status.name` should
 * show "name: string" as a documented field rather than letting the
 * user type a path that resolves to undefined at runtime.
 *
 * The audit's `condition-path-unknown` warning uses the same schemas;
 * a path that's unknown to the editor is also unknown to the audit.
 */
export function createContextSchemasHandler(agents: readonly ResolvedAgent[]) {
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
    response.json(buildContextSchemas(agent));
  };
}
