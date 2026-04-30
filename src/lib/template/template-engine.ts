import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import nunjucks from 'nunjucks';

const DOC_TAG_PATTERN = /\{\{doc:([^}]+)\}\}/g;
const SHARED_TAG_PATTERN = /\{\{shared:([^}]+)\}\}/g;

async function readAgentDoc(agentDir: string, relativePath: string): Promise<string> {
  return await readFile(join(agentDir, relativePath), 'utf-8');
}

async function readSharedDoc(agentDir: string, relativePath: string): Promise<string> {
  // Shared docs live at <workspaces>/shared/<path>, i.e. one level up from the
  // agent workspace. We normalize the full path and require it to stay inside
  // that shared directory — no `..` escapes.
  const sharedRoot = resolve(dirname(agentDir), 'shared');
  const fullPath = resolve(sharedRoot, relativePath);
  if (fullPath !== sharedRoot && !fullPath.startsWith(`${sharedRoot}${sep}`)) {
    throw new Error(
      `Shared doc path escapes shared root: ${relativePath} -> ${fullPath} (root: ${sharedRoot})`,
    );
  }
  return await readFile(fullPath, 'utf-8');
}

async function preprocessDocTags(template: string, agentDir: string): Promise<string> {
  const docMatches = [...template.matchAll(DOC_TAG_PATTERN)];
  const sharedMatches = [...template.matchAll(SHARED_TAG_PATTERN)];
  if (docMatches.length === 0 && sharedMatches.length === 0) {
    return template;
  }

  const docContents = await Promise.all(
    docMatches.map((match) => readAgentDoc(agentDir, match[1]!.trim())),
  );
  const sharedContents = await Promise.all(
    sharedMatches.map((match) => readSharedDoc(agentDir, match[1]!.trim())),
  );

  let result = template;
  for (let index = 0; index < docMatches.length; index++) {
    result = result.replace(docMatches[index]![0], docContents[index]!);
  }
  for (let index = 0; index < sharedMatches.length; index++) {
    result = result.replace(sharedMatches[index]![0], sharedContents[index]!);
  }

  return result;
}

const nunjucksEnvironment = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

export async function renderTemplate(
  template: string,
  payload: unknown,
  baseDir: string,
): Promise<string> {
  const preprocessed = await preprocessDocTags(template, baseDir);

  const spreadable = typeof payload === 'object' && payload !== null ? payload : {};
  const context = {
    payload: JSON.stringify(payload, null, 2),
    ...spreadable,
  };

  return nunjucksEnvironment.renderString(preprocessed, context);
}
