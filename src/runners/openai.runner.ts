import { z } from 'zod';

import { getLogger } from '../lib/logging';
import type { AgentRunner, RunOptions, RunResult, OpenAiRunnerConfig } from './types';

const logger = getLogger('runner:openai');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const OpenAiResponseSchema = z
  .object({
    id: z.string().optional(),
  })
  .passthrough();

async function interpretOpenAiResponse(
  response: Response,
  options: RunOptions,
  startedAt: string,
): Promise<RunResult> {
  const endedAt = new Date().toISOString();
  if (!response.ok) {
    const body = await response.text();
    logger.error({ status: response.status, body: body.slice(0, 500) }, 'OpenAI API error');
    return {
      status: 'error',
      error: `OpenAI API returned ${response.status}: ${body.slice(0, 200)}`,
      startedAt,
      endedAt,
      renderedPrompt: options.prompt,
    };
  }
  const data = OpenAiResponseSchema.parse(await response.json());
  logger.info({ responseId: data.id }, 'OpenAI completions returned');
  return { status: 'ok', runId: data.id, startedAt, endedAt, renderedPrompt: options.prompt };
}

function toErrorResult(error: unknown, options: RunOptions, startedAt: string): RunResult {
  const endedAt = new Date().toISOString();
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return {
      status: 'timeout',
      error: `OpenAI request timed out after ${options.timeoutMs}ms`,
      startedAt,
      endedAt,
      renderedPrompt: options.prompt,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ error: message }, 'OpenAI request failed');
  return { status: 'error', error: message, startedAt, endedAt, renderedPrompt: options.prompt };
}

/**
 * Calls the OpenAI Chat Completions API (or any compatible endpoint).
 * Uses native fetch — no SDK dependency.
 */
export class OpenAiRunner implements AgentRunner {
  readonly name = 'openai';
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenAiRunnerConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  isHealthy(): boolean {
    // Stateless HTTP — always considered healthy.
    return true;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const model = options.model ?? this.model;
    const url = `${this.baseUrl}/chat/completions`;

    logger.info({ model, baseUrl: this.baseUrl }, 'Calling OpenAI completions');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: options.prompt }],
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      return await interpretOpenAiResponse(response, options, startedAt);
    } catch (error) {
      return toErrorResult(error, options, startedAt);
    }
  }
}
