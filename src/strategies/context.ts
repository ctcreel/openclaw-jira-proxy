/**
 * Provider-specific webhook context extraction.
 *
 * Each provider strategy knows how to pull identifying fields
 * (ID, title, status) from its webhook payload shape.
 */

import type { ProviderConfig } from '../config';
import { getScalarField, getStringField } from '../lib/extract';
import { resolveFieldPath } from './routing/field-path';

export interface WebhookContext {
  /** Primary identifier (e.g., "SPE-1622", "SC0RED/repo#42") */
  id: string;
  /** Human-readable title */
  title: string;
  /** Current status or action */
  status: string;
  /** Source system */
  source: string;
}

export interface ContextStrategy {
  readonly name: string;
  extract(payload: unknown): WebhookContext;
}

const jiraStrategy: ContextStrategy = {
  name: 'jira',
  extract(payload: unknown): WebhookContext {
    return {
      id: getStringField(payload, 'issue.key'),
      title: getStringField(payload, 'issue.fields.summary').slice(0, 80),
      status: getStringField(payload, 'issue.fields.status.name'),
      source: 'jira',
    };
  },
};

const githubStrategy: ContextStrategy = {
  name: 'github',
  extract(payload: unknown): WebhookContext {
    let id = getStringField(payload, 'repository.full_name');
    let title = '?';

    const prNumber = getScalarField(payload, 'pull_request.number');
    const issueNumber = getScalarField(payload, 'issue.number');
    const ref = getStringField(payload, 'ref', '');

    if (prNumber !== undefined) {
      id += `#${prNumber}`;
      title = getStringField(payload, 'pull_request.title').slice(0, 80);
    } else if (issueNumber !== undefined) {
      id += `#${issueNumber}`;
      title = getStringField(payload, 'issue.title').slice(0, 80);
    } else if (ref.length > 0) {
      id += ` ${ref}`;
      title = 'push';
    }

    return {
      id,
      title,
      status: getStringField(payload, 'action'),
      source: 'github',
    };
  },
};

const SLACK_CHANNEL_ENVIRONMENT: Record<string, string> = {
  C08V6MV0VNV: 'development',
  C08UWMQJFBN: 'testing',
  C08UVJDJZTL: 'production',
};

const slackStrategy: ContextStrategy = {
  name: 'slack',
  extract(payload: unknown): WebhookContext {
    let title = '?';
    const blocks = resolveFieldPath(payload, 'event.blocks');
    if (Array.isArray(blocks) && blocks.length > 0) {
      const firstBlock: unknown = blocks[0];
      const text = getStringField(firstBlock, 'text.text', '');
      // Slack message blocks have either { text: { text: "..." } } or
      // { text: "..." } depending on block type. Fall through to the
      // shorter shape when the structured one is empty.
      const resolved = text.length > 0 ? text : getStringField(firstBlock, 'text', '');
      if (resolved.length > 0) title = resolved.slice(0, 80);
    }

    const channelId = getStringField(payload, 'event.channel', '');
    const environment = SLACK_CHANNEL_ENVIRONMENT[channelId] ?? 'unknown';

    return {
      id: getStringField(payload, 'event.ts'),
      title,
      status: environment,
      source: 'slack',
    };
  },
};

/**
 * gmail-pubsub coalescing strategy.
 *
 * Gmail's watch fires a Pub/Sub notification every time the watched
 * mailbox changes — including changes Winston himself causes (removing
 * INBOX, applying labels). That creates a self-feeding cascade: each
 * triage run modifies labels, each label change fires Pub/Sub, each
 * Pub/Sub queues another triage. Inboxes drain eventually but every
 * intermediate triage burns a slot in the worker queue.
 *
 * The Gmail API has no "INBOX adds only, ignore removes" filter, so the
 * fix lives at the ingestion layer here. By returning `emailAddress` as
 * the dedup id, the shared dedup keyed by `provider:context.id:status`
 * coalesces every gmail-pubsub notification for the same mailbox within
 * `DEDUP_TTL_SECONDS` (default 60s) into a single triage job. The first
 * notification enqueues; the rest land at 202 with `duplicate: true`
 * and never reach BullMQ.
 *
 * No messages are lost: the triage template's first call is
 * `gmail_search(is:unread label:inbox)`, which picks up every still-
 * unread message regardless of which historyId fired the notification.
 * Coalescing means "process the inbox once per 60s window," not "drop
 * mail" — by design, identical to how cron-debounced inbox fetchers
 * work elsewhere.
 */
const gmailPubsubStrategy: ContextStrategy = {
  name: 'gmail-pubsub',
  extract(payload: unknown): WebhookContext {
    const emailAddress = getStringField(payload, 'emailAddress', '');
    const historyId = getStringField(payload, 'historyId', '');
    return {
      id: emailAddress.length > 0 ? emailAddress : '?',
      title: historyId.length > 0 ? `history ${historyId}` : '?',
      status: 'pubsub',
      source: 'gmail-pubsub',
    };
  },
};

const fallbackStrategy: ContextStrategy = {
  name: 'unknown',
  extract(_payload: unknown): WebhookContext {
    return { id: '?', title: '?', status: '?', source: 'unknown' };
  },
};

const strategies: Record<string, ContextStrategy> = {
  jira: jiraStrategy,
  github: githubStrategy,
  slack: slackStrategy,
  'gmail-pubsub': gmailPubsubStrategy,
};

export function getContextStrategy(provider: ProviderConfig): ContextStrategy {
  const key = provider.contextStrategy ?? provider.name;
  return strategies[key] ?? fallbackStrategy;
}

export function extractWebhookContext(provider: ProviderConfig, payload: unknown): WebhookContext {
  return getContextStrategy(provider).extract(payload);
}
