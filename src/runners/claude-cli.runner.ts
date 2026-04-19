import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getLogger } from '../lib/logging';
import { getEventBus } from '../services/event-bus.service';
import type { AgentRunner, RunOptions, RunResult, ClaudeCliRunnerConfig } from './types';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

const logger = getLogger('runner:claude-cli');

function emitStreamEvent(
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
  event: Record<string, unknown>,
): void {
  const type = event.type as string | undefined;
  const bus = getEventBus();
  const timestamp = Date.now();

  if (type === 'assistant' && event.message) {
    const message = event.message as Record<string, unknown>;
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const preview = block.text.length > 200 ? block.text.slice(0, 200) + '...' : block.text;
        logger.info({ runId, event: 'assistant_text' }, preview);
        if (traceId && jobId) {
          bus.publish({
            type: 'runner.assistant_text',
            timestamp,
            traceId,
            jobId,
            runId,
            text: block.text,
          });
        }
      } else if (block.type === 'tool_use') {
        logger.info(
          { runId, event: 'tool_call', tool: block.name },
          `Tool: ${block.name as string}`,
        );
        if (traceId && jobId) {
          bus.publish({
            type: 'runner.tool_call',
            timestamp,
            traceId,
            jobId,
            runId,
            tool: String(block.name),
            args: block.input,
          });
        }
      }
    }
  } else if (type === 'result') {
    logger.info(
      { runId, event: 'result', turns: event.num_turns, cost: event.total_cost_usd },
      `Run finished — ${event.num_turns} turns, $${event.total_cost_usd}`,
    );
    if (traceId && jobId) {
      bus.publish({
        type: 'runner.result',
        timestamp,
        traceId,
        jobId,
        runId,
        turns: Number(event.num_turns ?? 0),
        costUsd: Number(event.total_cost_usd ?? 0),
      });
    }
  }
}

/**
 * Spawns a `claude -p` subprocess for each run.
 * Parses stream-json output for structured results.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly name = 'claude-cli';
  private readonly workDirectory: string;
  private readonly binary: string;
  private readonly systemPrompt: string | undefined;

  constructor(config: ClaudeCliRunnerConfig) {
    this.workDirectory = config.workDirectory;
    this.binary = config.binary ?? 'claude';
    this.systemPrompt = config.systemPrompt;
  }

  async close(): Promise<void> {
    // No resources to clean up — `claude -p` is spawned per run.
  }

  isHealthy(): boolean {
    // Env-var injected token (Mac plist path) OR file-based credentials
    // written by `claude login` (Linux / EC2 path). Either is authoritative.
    return process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined || existsSync(CREDENTIALS_PATH);
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const runId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const args = [
      '-p',
      options.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '50',
      '--dangerously-skip-permissions',
    ];

    if (options.model) {
      args.push('--model', options.model);
    }

    if (this.systemPrompt) {
      args.push('--system-prompt', this.systemPrompt);
    }

    logger.info(
      { runId, binary: this.binary, workDirectory: this.workDirectory },
      'Spawning Claude CLI',
    );

    return new Promise<RunResult>((resolve) => {
      const proc = spawn(this.binary, args, {
        cwd: this.workDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stderr = '';
      let stdoutBuffer = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5_000);
      }, options.timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuffer += text;

        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            emitStreamEvent(runId, options.traceId, options.jobId, event);
          } catch {
            // Not valid JSON — skip
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const endedAt = new Date().toISOString();

        if (timedOut) {
          resolve({
            status: 'timeout',
            runId,
            startedAt,
            endedAt,
            renderedPrompt: options.prompt,
            error: `Claude CLI timed out after ${options.timeoutMs}ms`,
          });
          return;
        }

        if (code !== 0) {
          const errorMessage = stderr.trim() || `Claude CLI exited with code ${code}`;
          logger.error({ runId, code, stderr: stderr.slice(0, 500) }, 'Claude CLI failed');
          resolve({
            status: 'error',
            runId,
            error: errorMessage,
            startedAt,
            endedAt,
            renderedPrompt: options.prompt,
          });
          return;
        }

        logger.info({ runId }, 'Claude CLI completed');
        resolve({
          status: 'ok',
          runId,
          startedAt,
          endedAt,
          renderedPrompt: options.prompt,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        logger.error({ runId, error: error.message }, 'Claude CLI spawn error');
        resolve({
          status: 'error',
          runId,
          error: error.message,
          startedAt,
          endedAt: new Date().toISOString(),
          renderedPrompt: options.prompt,
        });
      });
    });
  }
}
