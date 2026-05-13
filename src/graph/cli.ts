#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { argv, cwd, exit, stdout } from 'node:process';
import { basename, resolve } from 'node:path';

import { renderGraphFromDisk } from './render';

/**
 * `clawndom-graph <agent-dir> [--out <path>] [--name <label>]`
 *
 * Reads the workspace's clawndom.yaml, parses + validates it via the audit
 * loader, renders a Mermaid flowchart, prints to stdout or writes to a file.
 *
 * The output is a fenced ```mermaid block suitable for inclusion in a
 * README — GitHub renders it inline. Re-run on every push to keep the
 * diagram in sync with the config.
 */

interface ParsedArgs {
  readonly agentDir: string;
  readonly out?: string;
  readonly name?: string;
}

type ArgsResult = ParsedArgs | { error: string };

function parseArgs(rawArgv: readonly string[]): ArgsResult {
  const positional: string[] = [];
  let out: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rawArgv.length; i += 1) {
    const argument = rawArgv[i];
    if (argument === undefined) continue;
    if (argument === '-h' || argument === '--help') {
      return { error: 'help' };
    }
    if (argument === '--out') {
      const next = rawArgv[i + 1];
      if (next === undefined) return { error: '--out requires a path argument.' };
      out = next;
      i += 1;
      continue;
    }
    if (argument.startsWith('--out=')) {
      out = argument.slice('--out='.length);
      continue;
    }
    if (argument === '--name') {
      const next = rawArgv[i + 1];
      if (next === undefined) return { error: '--name requires a label argument.' };
      name = next;
      i += 1;
      continue;
    }
    if (argument.startsWith('--name=')) {
      name = argument.slice('--name='.length);
      continue;
    }
    if (argument.startsWith('-')) return { error: `Unknown flag: ${argument}` };
    positional.push(argument);
  }
  if (positional.length === 0) return { error: 'Missing required <agent-dir> argument.' };
  if (positional.length > 1) {
    return { error: `Unexpected extra arguments: ${positional.slice(1).join(' ')}` };
  }
  return {
    agentDir: resolve(cwd(), positional[0]!),
    out: out !== undefined ? resolve(cwd(), out) : undefined,
    name,
  };
}

const HELP = `clawndom-graph — render an agent workspace as a Mermaid flowchart.

Usage:
  clawndom-graph <agent-dir> [--out <path>] [--name <label>]

Arguments:
  <agent-dir>          Path to the agent workspace (dir containing clawndom.yaml).

Options:
  --out <path>         Write output to file instead of stdout.
  --name <label>       Label the diagram (defaults to the agent-dir basename).
  -h, --help           Show this message.

Output is a fenced \`\`\`mermaid block. GitHub renders it inline in markdown,
so the natural destination is the agent repo's README — re-render on every
push to keep the diagram in sync with clawndom.yaml.
`;

async function runCli(): Promise<number> {
  const parsed = parseArgs(argv.slice(2));
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${HELP}`);
    return 2;
  }

  const label = parsed.name ?? basename(parsed.agentDir);
  const diagram = await renderGraphFromDisk(parsed.agentDir, { agentName: label });

  if (parsed.out !== undefined) {
    await writeFile(parsed.out, diagram, 'utf-8');
    stdout.write(`Wrote ${parsed.out}\n`);
  } else {
    stdout.write(diagram);
  }
  return 0;
}

runCli()
  .then((code) => exit(code))
  .catch((error) => {
    process.stderr.write(`graph failed: ${(error as Error).message}\n`);
    if ((error as Error).stack !== undefined) {
      process.stderr.write(`${(error as Error).stack}\n`);
    }
    exit(2);
  });
