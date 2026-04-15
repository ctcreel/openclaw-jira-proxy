# src/secrets/

Strategy-pattern secrets management. Providers declare what secrets they need (logical keys). The global secrets config maps keys to vault-specific backends.

## Public API

Import from `./index.ts`:

- `SecretProvider` interface, `SecretBinding` type, `SecretManager` class
- `registerSecretProvider()`, `getSecretProvider()`, `getSecretManager()`
- Providers: `EnvSecretProvider`, `OnePasswordProvider`, `OAuthSecretProvider`, `FileSecretProvider`

## Adding a new provider

1. Create `src/secrets/<name>.provider.ts` implementing `SecretProvider`
2. Add its config type to the discriminated union in `types.ts`
3. Register it in `src/server.ts` startup wiring
4. Export from `index.ts`

Consumers call `getSecretManager().getSecret("key")` — they never know which backend resolved it.
