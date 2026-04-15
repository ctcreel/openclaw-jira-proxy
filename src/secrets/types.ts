import { z } from 'zod';

// ---------------------------------------------------------------------------
// Secret binding — maps a logical key to a vault-specific reference
// ---------------------------------------------------------------------------

export const secretBindingSchema = z.object({
  /** Logical key that consumers use to retrieve this secret (e.g., "jira_hmac"). */
  key: z.string().min(1),
  /** Which SecretProvider resolves this key (e.g., "env", "onepassword", "oauth"). */
  provider: z.string().min(1),
  /** Provider-specific locator (e.g., env var name, 1Password URI, file path). */
  reference: z.string().min(1),
  /** Refresh interval in seconds. Omit for static secrets. */
  ttlSeconds: z.number().positive().optional(),
  /** If true (default), failure to resolve prevents startup. */
  required: z.boolean().default(true),
});

export type SecretBinding = z.infer<typeof secretBindingSchema>;

// ---------------------------------------------------------------------------
// Resolved secret — value held in memory with metadata
// ---------------------------------------------------------------------------

export interface ResolvedSecret {
  readonly key: string;
  readonly value: string;
  readonly resolvedAt: Date;
  readonly expiresAt?: Date;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Secret provider interface — strategy for fetching secrets from a backend
// ---------------------------------------------------------------------------

export interface SecretProvider {
  readonly name: string;

  /**
   * Resolve one or more secret bindings from this backend.
   * Returns a map of key → value for successfully resolved secrets.
   * Missing keys are omitted from the result (not errors).
   */
  resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>>;

  /** Optional: one-time initialization (e.g., verify connectivity). */
  initialize?(): Promise<void>;

  /** Optional: tear down connections. */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider configuration schemas (discriminated union by `type`)
// ---------------------------------------------------------------------------

const envProviderConfigSchema = z.object({
  type: z.literal('env'),
});

const onePasswordProviderConfigSchema = z.object({
  type: z.literal('onepassword'),
  /** Path to the `op` CLI binary. Default: resolved via PATH. */
  binary: z.string().optional(),
});

const oauthProviderConfigSchema = z.object({
  type: z.literal('oauth'),
  /** Token endpoint URL. */
  tokenUrl: z.string().url(),
  /** OAuth client ID. */
  clientId: z.string().min(1),
  /** Scopes to request on refresh. */
  scopes: z.string().optional(),
});

const fileProviderConfigSchema = z.object({
  type: z.literal('file'),
  /** Base directory for secret files. */
  basePath: z.string().min(1),
});

export const secretProviderConfigSchema = z.discriminatedUnion('type', [
  envProviderConfigSchema,
  onePasswordProviderConfigSchema,
  oauthProviderConfigSchema,
  fileProviderConfigSchema,
]);

export type SecretProviderConfig = z.infer<typeof secretProviderConfigSchema>;
export type EnvProviderConfig = z.infer<typeof envProviderConfigSchema>;
export type OnePasswordProviderConfig = z.infer<typeof onePasswordProviderConfigSchema>;
export type OAuthProviderConfig = z.infer<typeof oauthProviderConfigSchema>;
export type FileProviderConfig = z.infer<typeof fileProviderConfigSchema>;
