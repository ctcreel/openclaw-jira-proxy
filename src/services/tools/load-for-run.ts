import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getLogger } from '../../lib/logging';
import { getSecretManager, type SecretManager } from '../../secrets/manager';
import type { RuleTools } from './config-schemas';
import type { SecretSpecification, ToolDescriptor } from './descriptor';
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
export async function buildMCPBundle(
  tools: RuleTools | undefined,
  agentDir: string,
  context: BridgeContext,
): Promise<MCPRunFiles | undefined> {
  if (tools === undefined || tools.length === 0) return undefined;

  const descriptors: ToolDescriptor[] = [];
  for (const ref of tools) {
    descriptors.push(await loadToolDescriptor(ref, agentDir));
  }

  const perTool: Record<string, Record<string, string>> = {};
  const secretManager = getSecretManager();
  for (const desc of descriptors) {
    const creds: Record<string, string> = {};
    for (const specification of desc.secrets) {
      creds[specification.canonical] = resolveSecretFromAliases(
        specification,
        secretManager,
        desc.name,
      );
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
 * Try each alias in order; return the value of the first one SecretManager
 * has resolved. Throws a clear error if no alias resolves — operators see
 * exactly which keys they could declare to fix the gap.
 *
 * Boot-time validation in `agent-loader.service.ts` runs this check too,
 * so a missing-alias error here would normally have surfaced at startup.
 * Keeping the runtime guard means a key removed mid-run still fails loudly.
 */
export function resolveSecretFromAliases(
  specification: SecretSpecification,
  secretManager: SecretManager,
  toolName: string,
): string {
  for (const alias of specification.aliases) {
    if (secretManager.hasSecret(alias)) {
      return secretManager.getSecret(alias);
    }
  }
  throw new Error(
    `Tool '${toolName}' needs secret '${specification.canonical}' but none of its declared ` +
      `aliases [${specification.aliases.join(', ')}] are registered in SECRETS_CONFIG.`,
  );
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
