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
};

export function getContextStrategy(provider: ProviderConfig): ContextStrategy {
  const key = provider.contextStrategy ?? provider.name;
  return strategies[key] ?? fallbackStrategy;
}

export function extractWebhookContext(provider: ProviderConfig, payload: unknown): WebhookContext {
  return getContextStrategy(provider).extract(payload);
}
