/**
 * Provider-specific webhook context extraction.
 *
 * Each provider strategy knows how to pull identifying fields
 * (ID, title, status) from its webhook payload shape.
 */

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
    const issueKey = resolveFieldPath(payload, 'issue.key');
    const summary = resolveFieldPath(payload, 'issue.fields.summary');
    const statusName = resolveFieldPath(payload, 'issue.fields.status.name');

    return {
      id: typeof issueKey === 'string' ? issueKey : '?',
      title: typeof summary === 'string' ? summary.slice(0, 80) : '?',
      status: typeof statusName === 'string' ? statusName : '?',
      source: 'jira',
    };
  },
};

const githubStrategy: ContextStrategy = {
  name: 'github',
  extract(payload: unknown): WebhookContext {
    const repo = resolveFieldPath(payload, 'repository.full_name');
    const action = resolveFieldPath(payload, 'action');

    const prNumber = resolveFieldPath(payload, 'pull_request.number');
    const prTitle = resolveFieldPath(payload, 'pull_request.title');
    const issueNumber = resolveFieldPath(payload, 'issue.number');
    const issueTitle = resolveFieldPath(payload, 'issue.title');
    const ref = resolveFieldPath(payload, 'ref');

    let id = typeof repo === 'string' ? repo : '?';
    let title = '?';

    if (typeof prNumber === 'number' || typeof prNumber === 'string') {
      id += `#${prNumber}`;
      title = typeof prTitle === 'string' ? prTitle.slice(0, 80) : '?';
    } else if (typeof issueNumber === 'number' || typeof issueNumber === 'string') {
      id += `#${issueNumber}`;
      title = typeof issueTitle === 'string' ? issueTitle.slice(0, 80) : '?';
    } else if (typeof ref === 'string') {
      id += ` ${ref}`;
      title = 'push';
    }

    return {
      id,
      title,
      status: typeof action === 'string' ? action : '?',
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
    const messageTimestamp = resolveFieldPath(payload, 'event.ts');
    const channel = resolveFieldPath(payload, 'event.channel');
    const blocks = resolveFieldPath(payload, 'event.blocks');

    let title = '?';
    if (Array.isArray(blocks) && blocks.length > 0) {
      // resolveFieldPath accepts unknown — no narrowing cast needed.
      const firstBlock: unknown = blocks[0];
      const text =
        resolveFieldPath(firstBlock, 'text.text') ?? resolveFieldPath(firstBlock, 'text');
      if (typeof text === 'string') {
        title = text.slice(0, 80);
      }
    }

    const channelId = typeof channel === 'string' ? channel : '';
    const environment = SLACK_CHANNEL_ENVIRONMENT[channelId] ?? 'unknown';

    return {
      id: typeof messageTimestamp === 'string' ? messageTimestamp : '?',
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

export function getContextStrategy(providerName: string): ContextStrategy {
  return strategies[providerName] ?? fallbackStrategy;
}

export function extractWebhookContext(providerName: string, payload: unknown): WebhookContext {
  return getContextStrategy(providerName).extract(payload);
}
