# Secrets Management

## 1Password Integration

All credentials live in the **Engineering** vault in 1Password. GitHub repos need only one repo-level credential: `OP_SERVICE_ACCOUNT_TOKEN`.

### Workflow

1. Store secrets in 1Password Engineering vault
2. GitHub Actions loads secrets via `1password/load-secrets-action@v2`
3. No secrets in GitHub Secrets (except the 1Password service account token)

### Per-Environment Items

- `AWS_ACCESS_KEY_ID_{ENV}`, `AWS_SECRET_ACCESS_KEY_{ENV}`
- `AWS_ACCOUNT_ID_{ENV}`, `AWS_REGION_{ENV}`

### Shared Items

- `SONAR_TOKEN`
- `SLACK_WEBHOOK_URL`
- `OP_SERVICE_ACCOUNT_TOKEN`

## Local Development

Use 1Password CLI:
```bash
op account get           # Verify authentication
op read "op://Engineering/SONAR_TOKEN/credential"  # Read a secret
```
