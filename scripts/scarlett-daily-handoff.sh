#!/usr/bin/env bash
# Fire Scarlett's daily-handoff task on Clawndom.
#
# Called by clawndom-scarlett-handoff.service (a oneshot triggered by the
# corresponding timer at 7:45 AM ET on weekdays). Lives as its own script
# so the JSON body and bearer-auth dance don't have to be quoted into a
# systemd ExecStart line.
#
# Reads CLAWNDOM_AGENT_TOKEN from /etc/clawndom/clawndom.env (loaded via
# the unit's EnvironmentFile=). POSTs to the local Clawndom API; the
# rest of the work happens inside the agent runner.

set -euo pipefail

if [[ -z "${CLAWNDOM_AGENT_TOKEN:-}" ]]; then
  echo "CLAWNDOM_AGENT_TOKEN is not set; refusing to fire daily-handoff" >&2
  exit 1
fi

curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer ${CLAWNDOM_AGENT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"agent":"scarlett","taskType":"daily-handoff","context":{}}' \
  http://127.0.0.1:8793/api/tasks
echo
