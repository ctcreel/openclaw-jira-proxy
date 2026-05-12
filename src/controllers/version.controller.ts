import type { Request, Response } from 'express';

import { getAgentVersion } from '../services/version.service';

/**
 * GET /version
 *
 * Returns the cached agent_version hash plus per-repo breakdown. Auditors
 * dereference any audit record's `agent_version` field to this manifest.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-versioning/spec.md`,
 * Requirement: Version Endpoint.
 */
export function handleGetVersion(_request: Request, response: Response): void {
  const version = getAgentVersion();
  response.json({
    agent_version: version.hash,
    repos: version.repos,
  });
}
