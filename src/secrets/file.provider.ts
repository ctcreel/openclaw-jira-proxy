import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger } from '../lib/logging';
import type { SecretProvider, SecretBinding, FileProviderConfig } from './types';

const logger = getLogger('secret:file');

/**
 * Reads secrets from files on disk. The `reference` field is the filename
 * relative to the configured `basePath`. Files should be chmod 600.
 *
 * Example: basePath "/etc/clawndom/secrets", reference "jira-hmac"
 * reads from /etc/clawndom/secrets/jira-hmac
 */
export class FileSecretProvider implements SecretProvider {
  readonly name = 'file';
  private readonly basePath: string;

  constructor(config: FileProviderConfig) {
    this.basePath = config.basePath;
  }

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();

    for (const binding of bindings) {
      const filePath = join(this.basePath, binding.reference);
      try {
        const value = (await readFile(filePath, 'utf-8')).trim();
        result.set(binding.key, value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { key: binding.key, path: filePath, error: message },
          'Failed to read secret file',
        );
      }
    }

    return result;
  }
}
