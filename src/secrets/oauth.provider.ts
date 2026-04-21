import { getLogger } from '../lib/logging';
import type { SecretProvider, SecretBinding, OAuthProviderConfig } from './types';

const logger = getLogger('secret:oauth');

/**
 * Resolves OAuth access tokens via the refresh_token grant.
 *
 * The `reference` field in a SecretBinding is the logical key for the
 * bootstrap refresh token (resolved from another provider or env var first).
 *
 * Bindings with this provider should declare two secrets:
 *   - The refresh token (bootstrap, resolved by env/1password provider)
 *   - The access token (resolved by this provider using the refresh token)
 *
 * In practice, the SecretManager resolves the refresh token first (from env
 * or 1Password), then this provider uses it to obtain the access token.
 *
 * Convention: if a binding's reference starts with "refresh:", the provider
 * reads the refresh token from SecretManager using the key after the prefix,
 * performs the grant, and returns the access token under the binding's key.
 */
export class OAuthSecretProvider implements SecretProvider {
  readonly name = 'oauth';
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly scopes: string | undefined;
  private refreshToken: string | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: OAuthProviderConfig) {
    this.tokenUrl = config.tokenUrl;
    this.clientId = config.clientId;
    this.scopes = config.scopes;
  }

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();

    for (const binding of bindings) {
      // The reference is the refresh token value directly (bootstrapped from env/1password)
      const refreshToken = binding.reference;
      if (!refreshToken) continue;

      try {
        const tokenResult = await this.exchangeRefreshToken(refreshToken);
        if (tokenResult) {
          result.set(binding.key, tokenResult.accessToken);
          // Store the new refresh token for subsequent refreshes
          if (tokenResult.refreshToken) {
            this.refreshToken = tokenResult.refreshToken;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ key: binding.key, error: message }, 'OAuth token exchange failed');
      }
    }

    return result;
  }

  async close(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async exchangeRefreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number } | null> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    };
    if (this.scopes) {
      body['scope'] = this.scopes;
    }

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth token endpoint returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      throw new Error('OAuth response missing access_token');
    }

    const expiresIn = data.expires_in ?? 28800;
    logger.info({ expiresInHours: (expiresIn / 3600).toFixed(1) }, 'OAuth token obtained');

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn,
    };
  }
}
