/**
 * Thread enrichment for memory retrieval. When configured on a rule,
 * fetches the full conversation thread and concatenates message bodies
 * into a single string for embedding. Falls back to the original query
 * on failure.
 */

import { getOptionalStringField } from '../../lib/extract';
import { getLogger } from '../../lib/logging';
import type { ThreadEnrichmentConfig } from './config-schemas';
import { fetchGmailThread } from './gmail-thread-fetcher';

const logger = getLogger('thread-enrichment');

const MAX_QUERY_CHARS = 15_000;

export async function enrichQueryWithThread(
  parsedPayload: unknown,
  config: ThreadEnrichmentConfig,
  fallbackQuery: string,
  traceId: string,
): Promise<string> {
  const threadId = getOptionalStringField(parsedPayload, config.threadIdField);
  const account = getOptionalStringField(parsedPayload, config.accountField);

  if (threadId === undefined || account === undefined) {
    logger.debug(
      { threadIdField: config.threadIdField, accountField: config.accountField, traceId },
      'Thread enrichment skipped — missing threadId or account',
    );
    return fallbackQuery;
  }

  try {
    const bodies = await fetchThread(config.provider, account, threadId, config.maxMessages);

    if (bodies.length === 0) {
      return fallbackQuery;
    }

    const joined = bodies.join('\n\n');
    const truncated = joined.length > MAX_QUERY_CHARS ? joined.slice(-MAX_QUERY_CHARS) : joined;

    logger.info(
      {
        provider: config.provider,
        threadId,
        messageCount: bodies.length,
        queryLength: truncated.length,
        traceId,
      },
      'Thread enrichment applied',
    );

    return truncated;
  } catch (error) {
    logger.warn(
      {
        provider: config.provider,
        threadId,
        error: error instanceof Error ? error.message : String(error),
        traceId,
      },
      'Thread enrichment failed — using fallback query',
    );
    return fallbackQuery;
  }
}

async function fetchThread(
  provider: 'gmail',
  account: string,
  threadId: string,
  maxMessages: number,
): Promise<readonly string[]> {
  switch (provider) {
    case 'gmail':
      return fetchGmailThread(account, threadId, maxMessages);
  }
}
