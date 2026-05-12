import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';

import { getToolReference, type ToolRef } from './config-schemas';
import {
  computeToolName,
  normalizeSecrets,
  toolYamlSchema,
  type ToolDescriptor,
} from './descriptor';
import { resolveToolDirectory } from './resolve';

/**
 * Load a tool's `tool.yaml` from its resolved directory, validate the YAML
 * structure, and produce a `ToolDescriptor` ready for registration with the
 * Anthropic API and downstream dispatch.
 *
 * The descriptor's `name` is `tool.yaml`'s `name:` override if present, else
 * derived from the directory path.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`,
 * Requirement: Tool Definition File Format.
 */
export async function loadToolDescriptor(ref: ToolRef, agentDir: string): Promise<ToolDescriptor> {
  const directory = await resolveToolDirectory(ref, agentDir);
  const yamlPath = join(directory, 'tool.yaml');
  let rawYaml: string;
  try {
    rawYaml = await readFile(yamlPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing or unreadable tool.yaml at ${yamlPath}: ${message}`);
  }

  const parsed = parseYaml(rawYaml);
  const validation = toolYamlSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      `Invalid tool.yaml at ${yamlPath}: ${validation.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  const yaml = validation.data;
  const name = yaml.name ?? computeToolName(directory);

  return {
    directory,
    reference: getToolReference(ref),
    name,
    description: yaml.description,
    args: yaml.args,
    secrets: normalizeSecrets(yaml.secrets),
  };
}
