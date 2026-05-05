# Operations

Runbook-style procedures for the EC2 host. Bootstrap is in `infra/ec2/bootstrap.sh`; this file covers things you do *after* bootstrap, on a running instance.

## Swap the host's Anthropic account

Every agent on the box (Patch, Scarlett, anything else routing through `claude-cli`) shares one set of Anthropic OAuth credentials at `/home/clawndom/.claude/.credentials.json`. To move the entire instance onto a different Anthropic subscription, replace that file via `claude login` — **without stopping the service**.

### Procedure

```bash
# 1. Confirm there's no env-var override masking the credentials file.
#    If CLAUDE_CODE_OAUTH_TOKEN is set, it wins over the file
#    (src/runners/claude-cli.runner.ts:165) and `claude login` will
#    appear to do nothing. Either remove it or replace its value with
#    a token from the new account.
sudo grep CLAUDE_CODE_OAUTH_TOKEN /etc/clawndom/clawndom.env

# 2. Re-login as the clawndom user with the new Anthropic account.
#    Interactive — opens an OAuth flow; paste the code back when prompted.
#    clawndom keeps running. No restart needed.
sudo -u clawndom claude login

# 3. Verify the service is still healthy.
curl http://localhost:8793/api/health
```

### Why not stop the service first

`claude` reads `~/.claude/.credentials.json` once at subprocess spawn and caches the OAuth access token in memory for the lifetime of that run. So:

- **The in-flight run** (if any) keeps using the old token it cached at spawn — it doesn't re-read the file mid-run. It either completes normally on the old account, or hits its own quota wall and surfaces a `quota_exceeded` result; the worker re-enqueues with delay, BullMQ pops the job after the reset, and the next pickup spawns a fresh subprocess that reads the *new* credentials.
- **Every subsequent run** spawns a fresh subprocess that reads the new `~/.claude/.credentials.json` directly. No service restart needed for new credentials to take effect.
- **The race window** during which `claude login` overwrites the credentials file is essentially nonexistent — `claude login` writes atomically (write-temp-then-rename), so a concurrent fresh-subprocess read sees either the old file or the new file, never a partial.

Older versions of this runbook stopped the service first as a precaution. That cost every in-flight run (subprocess SIGKILL'd by systemd, BullMQ re-enqueues, plan starts from scratch on the next pickup) and didn't actually buy any safety. Don't do it.

### What gets swapped

`claude login` overwrites the `claudeAiOauth` block (access token, refresh token, expiry) in `/home/clawndom/.claude/.credentials.json`. The `clawndom-claude-refresh.timer` keeps refreshing whatever account is in that file — no need to touch the timer.

### What does *not* get swapped

- **`OPENCLAW_TOKEN`** — Gateway bearer for the `openclaw` runner. Independent of the Anthropic account.
- **`OPENAI_API_KEY` / Bedrock creds** — Other runner backends. Independent.
- **Per-provider HMAC secrets** — Webhook signature validation. Independent.

### Authentication sources, in priority order

The `claude-cli` runner authenticates from one of two places (`src/runners/claude-cli.runner.ts:20,165`):

1. `CLAUDE_CODE_OAUTH_TOKEN` env var — wins if set.
2. `~/.claude/.credentials.json` — used otherwise. Resolved via `homedir()`, which is `/home/clawndom` because `clawndom.service` runs as `User=clawndom`.

If both are present, the env var wins and the file is ignored.
