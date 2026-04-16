# EC2 Migration Runbook

Move Clawndom from the MacBook to a dedicated EC2 instance in `sc0red-dev`
(us-east-1). The laptop stops being the critical path for Jira webhook
processing and the 8-hour Claude OAuth token refresh headache goes away.

## Target shape

- **Host**: t3.small, Ubuntu 24.04 LTS, in a public subnet with an Elastic IP
- **Network**: Tailscale node on the same tailnet as the laptop; no public
  inbound (SSH is Tailscale-only in practice, even though the CF template
  leaves an `AdminCidr` slot for break-glass access)
- **Services**: `clawndom.service` (the app), `redis-server` (localhost-only),
  `clawndom-sync-agents.timer` (git pulls every 5 min)
- **Secrets**: 1Password service account token in `/etc/clawndom/clawndom.env`;
  everything else resolved by Clawndom's `OnePasswordProvider` at startup
- **Agents**: cloned under `/home/clawndom/.clawndom/agents/` (matches
  `CLAWNDOM_CONFIG_DIR` default). Default agent is `the-agency` monorepo
  with `workspaces/patch/`.
- **Claude auth**: `claude login` run once as the `clawndom` user →
  credentials live at `/home/clawndom/.claude/.credentials.json` and
  `claude` refreshes itself. No env-var injection, no plist rewriting.

## Phase A — provision

```bash
export AWS_PROFILE=sc0red-dev
export AWS_REGION=us-east-1
aws cloudformation deploy \
  --stack-name clawndom-dev \
  --template-file infra/ec2/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      KeyPairName=<your-key-pair> \
      VpcId=<vpc-id> \
      SubnetId=<subnet-id> \
      AdminCidr=<your-ip>/32
```

Grab the Elastic IP from the stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name clawndom-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`InstancePublicIp`].OutputValue' \
  --output text
```

## Phase B — bootstrap

SSH in with the key you pinned on the instance:

```bash
ssh -i ~/.ssh/<your-key>.pem ubuntu@<elastic-ip>
sudo bash <(curl -fsSL https://raw.githubusercontent.com/SC0RED/clawndom/main/infra/ec2/bootstrap.sh)
```

The script is idempotent — safe to re-run if it stops partway. At the end
it prints the manual next steps:

1. `sudo tailscale up --hostname=clawndom` (writes the auth URL to stdout —
   open it in a browser, authorize on the SC0RED tailnet)
2. Populate `/etc/clawndom/clawndom.env` with `OP_SERVICE_ACCOUNT_TOKEN`
   plus any env you don't want in 1Password (e.g., `CLAWNDOM_AGENT_TOKEN`
   generated fresh: `openssl rand -hex 32`). Example below.
3. `sudo -u clawndom claude login` — one-time interactive, establishes
   the CLI's file-based credentials. Pipe the URL to a local browser.
4. `sudo -u clawndom bash /opt/clawndom/scripts/sync-agents.sh` to clone
   the-agency into the default `CLAWNDOM_CONFIG_DIR`.
5. `sudo -u clawndom bash /opt/clawndom/scripts/deploy.sh` for the first
   build + start.

### Example `/etc/clawndom/clawndom.env`

```env
NODE_ENV=production
PORT=8793
LOG_LEVEL=info
LOG_FORMAT=json

# Agents
CLAWNDOM_CONFIG_DIR=/home/clawndom/.clawndom/agents
AGENTS_CONFIG=[{"name":"patch","repo":"git@github.com:SC0RED/the-agency.git","path":"workspaces/patch"}]

# Providers — transport only
PROVIDERS_CONFIG=[{"name":"jira","routePath":"/hooks/jira","signatureStrategy":"websub","runner":{"type":"claude-cli","workDirectory":"/home/clawndom/.openclaw/workspace-patch","binary":"/usr/bin/claude"},"secrets":["jira_hmac"]}, ...]

# Secrets — 1Password + env
OP_SERVICE_ACCOUNT_TOKEN=ops_...
SECRETS_PROVIDERS_CONFIG=[{"type":"onepassword"}]
SECRETS_CONFIG=[{"key":"jira_hmac","provider":"onepassword","reference":"op://Clawndom/jira/hmac"}]

# Agent-to-agent tasks
CLAWNDOM_AGENT_TOKEN=<openssl rand -hex 32>

# Redis — bootstrap installs it and binds to localhost
REDIS_URL=redis://127.0.0.1:6379
```

## Phase C — GitHub Actions deploy

Set repo secrets on `SC0RED/clawndom`:

| Secret | Value |
| --- | --- |
| `EC2_HOST` | the Tailscale hostname or Elastic IP of the instance |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_PRIVATE_KEY` | the private key whose public half is on the instance |

After that, every push to `main` runs `make check` in CI, SSHes to the
instance, and invokes `scripts/deploy.sh` as the `clawndom` user. Deploys
are ~30 seconds end to end once dependencies are cached.

## Phase D — Jira webhook cutover

With the laptop's Clawndom still running and EC2 Clawndom verified
(`curl http://<tailnet-hostname>:8793/api/health` → `{"status":"ok",...}`):

1. Send a test webhook to EC2 manually:
   ```bash
   ./scripts/test-jira-webhook.sh <ec2-host>:8793
   ```
   Tail `/var/log/clawndom/clawndom.log` on EC2 and confirm routing
   matches + Claude CLI spawns + exits 0.
2. In Jira admin, update the webhook URL from the laptop's Tailscale
   hostname to the EC2 Tailscale hostname.
3. Fire any status transition on a test ticket; watch both laptop +
   EC2 logs. Only EC2 should pick it up.
4. Monitor EC2 for 24 hours. Mac's clawndom service keeps running
   harmlessly — it just stops receiving webhooks.
5. `launchctl unload ~/Library/LaunchAgents/com.openclaw.clawndom.plist`
   and the refresh agent. You can leave the files on disk for a while
   in case you need to roll back.

## Rollback

If EC2 Clawndom misbehaves, re-point the Jira webhook at the laptop.
Nothing is destroyed by the migration — the laptop plist still has the
old `PROVIDERS_CONFIG` shape, and the EC2 stack can be torn down with
`aws cloudformation delete-stack --stack-name clawndom-dev`.

## Known gaps / follow-ups

- **1Password service account vs personal vault**: the service account
  only sees items you explicitly share to it. Before first deploy,
  share `op://Clawndom/...` to the service account.
- **Runner env injection for `CLAWNDOM_AGENT_TOKEN`**: SPE-1707's task
  endpoint is live, but templates that want to `curl` back into
  `/api/tasks` need the token in the runner subprocess env. Small
  follow-up once Patch's first cross-agent template is written.
- **Dashboard**: the existing `scripts/dashboard.py` still polls logs
  every 5s. A rewrite to consume the SSE stream at `/api/events` is
  tracked informally — not on the critical path.
