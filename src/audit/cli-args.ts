import { cwd } from 'node:process';
import { resolve } from 'node:path';

/**
 * Parsed shape of the audit CLI's positional + flag arguments. Extracted
 * from `cli.ts` so it can be tested directly without spawning a process.
 */
export interface ParsedAuditArgs {
  readonly agentDir: string;
  readonly sharedDir?: string;
  readonly json: boolean;
}

export type AuditArgsResult = ParsedAuditArgs | { error: string };

export function parseAuditArgs(rawArgv: readonly string[]): AuditArgsResult {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rawArgv.length; i += 1) {
    const argument = rawArgv[i];
    if (argument === undefined) continue;
    if (argument === '--json') {
      flags['json'] = true;
      continue;
    }
    if (argument === '--shared-dir') {
      const value = rawArgv[i + 1];
      if (value === undefined) {
        return { error: '--shared-dir requires a path argument.' };
      }
      flags['sharedDir'] = value;
      i += 1;
      continue;
    }
    if (argument.startsWith('--shared-dir=')) {
      flags['sharedDir'] = argument.slice('--shared-dir='.length);
      continue;
    }
    if (argument === '-h' || argument === '--help') {
      flags['help'] = true;
      continue;
    }
    if (argument.startsWith('-')) {
      return { error: `Unknown flag: ${argument}` };
    }
    positional.push(argument);
  }
  if (flags['help']) {
    return { error: 'help' };
  }
  if (positional.length === 0) {
    return { error: 'Missing required <agent-dir> argument.' };
  }
  if (positional.length > 1) {
    return { error: `Unexpected extra arguments: ${positional.slice(1).join(' ')}` };
  }
  return {
    agentDir: resolve(cwd(), positional[0]!),
    sharedDir:
      typeof flags['sharedDir'] === 'string' ? resolve(cwd(), flags['sharedDir']) : undefined,
    json: flags['json'] === true,
  };
}
