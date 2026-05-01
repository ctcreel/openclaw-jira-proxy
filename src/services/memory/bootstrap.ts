import { getLogger } from '../../lib/logging';
import type { SecretManager } from '../../secrets/manager';
import { getDedupRedis } from '../dedup.service';
import type { ResolvedAgent } from '../agent-loader.service';

import { createOpenAIEmbeddingProvider, registerEmbeddingProvider } from './embedding';
import { initializeMemoryService } from './memory.service';
import type { NamespaceConfig } from './memory.service';
import { createRedisVectorStore, registerVectorStore } from './vector-store';

const logger = getLogger('memory-bootstrap');

const OPENAI_SECRET_KEY = 'openai_api_key';

/**
 * Build the MemoryService at server startup.
 *
 * 1. Walk all agents to collect declared namespaces.
 * 2. If any namespace uses provider `openai`, resolve the OpenAI API key
 *    from SecretManager and register the provider. Without OpenAI in use,
 *    the secret is not required.
 * 3. If any namespace uses store `redis`, register the RedisVectorStore
 *    bound to the existing dedup Redis singleton.
 * 4. Call `initializeMemoryService` so the singleton is ready before the
 *    worker pre-render hook or HTTP endpoints run.
 *
 * Returns the flat list of NamespaceConfig values, useful for the prune
 * scheduler that walks them on each tick.
 */
export async function bootstrapMemoryService(
  agents: readonly ResolvedAgent[],
  secretManager: SecretManager,
): Promise<readonly NamespaceConfig[]> {
  const namespaces: NamespaceConfig[] = [];
  let openaiInUse = false;
  let redisInUse = false;

  for (const agent of agents) {
    const memory = agent.config.memory;
    if (memory === undefined) continue;
    for (const [name, policy] of Object.entries(memory.namespaces)) {
      namespaces.push({
        name,
        embeddingProviderName: policy.embeddingProvider,
        vectorStoreName: policy.vectorStore,
        pruneAfterMs: policy.pruneAfter,
        maxStoresPerRun: policy.maxStoresPerRun,
      });
      if (policy.embeddingProvider === 'openai') openaiInUse = true;
      if (policy.vectorStore === 'redis') redisInUse = true;
    }
  }

  if (namespaces.length === 0) {
    logger.info('No memory namespaces declared; skipping MemoryService bootstrap');
    initializeMemoryService({ namespaces: [] });
    return [];
  }

  if (openaiInUse) {
    if (!secretManager.hasSecret(OPENAI_SECRET_KEY)) {
      throw new Error(
        `Memory bootstrap: at least one namespace uses 'openai' embeddings but secret '${OPENAI_SECRET_KEY}' is not declared in SECRETS_CONFIG.`,
      );
    }
    const apiKey = secretManager.getSecret(OPENAI_SECRET_KEY);
    registerEmbeddingProvider(createOpenAIEmbeddingProvider({ apiKey }));
    logger.info({ provider: 'openai' }, 'Registered OpenAI embedding provider');
  }

  if (redisInUse) {
    registerVectorStore(createRedisVectorStore({ redis: getDedupRedis() }));
    logger.info({ store: 'redis' }, 'Registered Redis vector store');
  }

  initializeMemoryService({ namespaces });
  logger.info(
    { namespaceCount: namespaces.length, namespaces: namespaces.map((ns) => ns.name) },
    'MemoryService initialized',
  );
  return namespaces;
}
