# Secrets Management

## 1Password Integration

All credentials live in the **Patch** vault in 1Password. The proxy loads secrets from environment variables at startup — secrets are injected via the launchd plist or a local `.env` file (not committed).

### Required Secrets

| Secret | Where it comes from | What it's for |
|--------|-------------------|---------------|
| `OPENCLAW_TOKEN` | OpenClaw gateway config | Bearer auth for `/hooks/agent` and WebSocket RPC |
| `JIRA_HMAC_SECRET` | Jira webhook config | HMAC signature validation on inbound Jira events |
| `GITHUB_HMAC_SECRET` | GitHub webhook config | HMAC signature validation on inbound GitHub events |

### Local Development

Use 1Password CLI to read secrets:

```bash
OP_TOKEN=$(security find-generic-password -s "openclaw.op_token_patch" -a "openclaw" -w 2>/dev/null)
OP_SERVICE_ACCOUNT_TOKEN=$OP_TOKEN op item get <item-id> --vault Patch --fields credential --reveal
```

### CI

If CI is configured, secrets are loaded via `1password/load-secrets-action@v2` using an `OP_SERVICE_ACCOUNT_TOKEN` stored as a GitHub repo secret.

## Rules

- **Never commit secrets** — Gitleaks runs pre-commit and in CI
- **Never hardcode** — All secrets come from environment variables
- **Rotate on exposure** — If a secret appears in logs or a commit, rotate immediately
