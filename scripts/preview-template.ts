/**
 * Preview a Nunjucks message template against a sample webhook payload.
 *
 * Usage:
 *   pnpm tsx scripts/preview-template.ts --template <path> --payload <path>
 *
 * Renders the template using the same renderTemplate function used at runtime.
 * Writes the result to stdout. No network calls or runner invocation.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { renderTemplate } from '../src/lib/template/template-engine';

interface ParsedArgs {
  template: string;
  payload: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let template: string | undefined;
  let payload: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--template' && argv[i + 1]) {
      template = argv[++i];
    } else if (argv[i] === '--payload' && argv[i + 1]) {
      payload = argv[++i];
    }
  }

  if (!template || !payload) {
    console.error('Usage: preview-template.ts --template <path> --payload <path>');
    process.exit(1);
  }

  return { template, payload };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.template)) {
    console.error(`Template file not found: ${args.template}`);
    process.exit(1);
  }

  if (!existsSync(args.payload)) {
    console.error(`Payload file not found: ${args.payload}`);
    process.exit(1);
  }

  const templateContent = await readFile(args.template, 'utf-8');
  const payloadContent = await readFile(args.payload, 'utf-8');

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadContent);
  } catch {
    console.error('Payload file is not valid JSON');
    process.exit(1);
  }

  const rendered = await renderTemplate(templateContent, parsedPayload);
  process.stdout.write(rendered);
}

main().catch((error: unknown) => {
  console.error('Preview failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
