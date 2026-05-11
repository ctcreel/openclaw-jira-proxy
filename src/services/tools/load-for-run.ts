import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getLogger } from '../../lib/logging';
import { getSecretManager } from '../../secrets/manager';
import type { RuleTools } from './config-schemas';
import { loadToolDescriptor } from './parse';
import {
  buildMCPRunFiles,
  type BridgeContext,
  type MCPRunFiles,
  type ResolvedCredentials,
} from './mcp-bridge';

const logger = getLogger('tools-load');

/**
 * Per-run preparation for a route's declared tools. Loads each tool's
 * descriptor, resolves its credentials via the SecretManager, and
 * materializes the MCP-config / tool-config files the claude-cli runner
 * passes to `--mcp-config`.
 *
 * Returns ``undefined`` when the route declares no tools so callers can
 * skip the MCP wiring entirely on the unmodified path.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Structured Tool-Use Dispatch.
 */
export async function prepareMCPBundle(
  tools: RuleTools | undefined,
  agentDir: string,
  context: BridgeContext,
): Promise<MCPRunFiles | undefined> {
  if (tools === undefined || tools.length === 0) return undefined;

  const descriptors = [];
  for (const ref of tools) {
    descriptors.push(await loadToolDescriptor(ref, agentDir));
  }

  const perTool: Record<string, Record<string, string>> = {};
  const secretManager = getSecretManager();
  for (const desc of descriptors) {
    const creds: Record<string, string> = {};
    for (const reqName of desc.requires) {
      creds[reqName] = secretManager.getSecret(reqName);
    }
    perTool[desc.name] = creds;
  }
  const credentials: ResolvedCredentials = { perTool };

  const bundle = await buildMCPRunFiles(descriptors, credentials, context);
  logger.info(
    {
      agentId: context.agentId,
      routeId: context.routeId,
      tools: descriptors.map((d) => d.name),
      mcpConfigPath: bundle.mcpConfigPath,
    },
    'Materialized MCP bundle for tool-equipped run',
  );
  return bundle;
}

/**
 * Remove the temporary directory holding the bundle's config files.
 * Safe to call after the run completes regardless of outcome.
 */
export async function cleanupMCPBundle(bundle: MCPRunFiles | undefined): Promise<void> {
  if (bundle === undefined) return;
  try {
    await rm(dirname(bundle.mcpConfigPath), { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to clean up MCP bundle temp dir',
    );
  }
}
