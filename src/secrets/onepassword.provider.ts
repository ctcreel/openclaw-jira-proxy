import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../lib/logging';
import type { SecretProvider, SecretBinding, OnePasswordProviderConfig } from './types';

const execFileAsync = promisify(execFile);
const logger = getLogger('secret:onepassword');

/**
 * Resolves secrets from 1Password using the `op` CLI with a service account token.
 * Requires OP_SERVICE_ACCOUNT_TOKEN in the process environment.
 *
 * The `reference` field in a SecretBinding is a 1Password secret reference URI:
 *   op://vault/item/field
 *
 * Example: op://Clawndom/jira-webhook/hmac-secret
 */
export class OnePasswordProvider implements SecretProvider {
  readonly name = 'onepassword';
  private readonly binary: string;
  private readonly token: string;

  constructor(config: OnePasswordProviderConfig) {
    this.binary = config.binary ?? 'op';
    const token = process.env['OP_SERVICE_ACCOUNT_TOKEN'];
    if (!token) {
      throw new Error('OP_SERVICE_ACCOUNT_TOKEN is required for the onepassword secret provider');
    }
    this.token = token;
  }

  async initialize(): Promise<void> {
    // Verify the op CLI is available and authenticated
    try {
      await execFileAsync(this.binary, ['--version'], {
        env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: this.token },
        timeout: 10_000,
      });
      logger.info('1Password CLI verified');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`1Password CLI not available: ${message}`);
    }
  }

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    const env = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: this.token };

    // Resolve each binding via `op read <reference>`
    const resolutions = bindings.map(async (binding) => {
      try {
        const { stdout } = await execFileAsync(
          this.binary,
          ['read', binding.reference, '--no-newline'],
          { env, timeout: 15_000, encoding: 'utf-8' },
        );
        result.set(binding.key, stdout);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { key: binding.key, reference: binding.reference, error: message },
          'Failed to resolve secret from 1Password',
        );
        // Don't set — the caller (SecretManager) handles missing required secrets
      }
    });

    await Promise.all(resolutions);
    return result;
  }
}
