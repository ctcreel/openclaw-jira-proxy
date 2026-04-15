#!/usr/bin/env python3
"""
Clawndom Dashboard — real-time view of webhook processing.

Usage: python3 scripts/dashboard.py
       python3 scripts/dashboard.py --once  (single snapshot, no refresh)
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

LOG_FILE = "/usr/local/var/log/clawndom.log"
HEALTH_URL = "http://127.0.0.1:8793/api/health"
REFRESH_SECONDS = 5

CLEAR = "\033[2J\033[H"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
RESET = "\033[0m"


# ── Data sources ──

def get_health():
    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "2", HEALTH_URL],
            capture_output=True, text=True,
        )
        return json.loads(result.stdout).get("status", "unknown")
    except Exception:
        return "unreachable"


def redis_cmd(*args):
    result = subprocess.run(
        ["redis-cli"] + list(args),
        capture_output=True, text=True,
    )
    return result.stdout.strip()


def get_queue_names():
    """Discover all BullMQ webhook queues from Redis."""
    keys = redis_cmd("KEYS", "bull:webhooks-*:wait")
    if not keys:
        return []
    return [k.rsplit(":wait", 1)[0] for k in keys.split("\n") if k.strip()]


def unwrap_job_payload(data_raw):
    """Unwrap BullMQ job data which may be multi-layered JSON strings."""
    data = json.loads(data_raw)
    while isinstance(data, str):
        data = json.loads(data)
    if isinstance(data, dict) and "payload" in data:
        payload = data["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return payload
    return data


def get_queue_items():
    """Read pending jobs from all discovered Redis BullMQ queues."""
    items = []
    for queue_key in get_queue_names():
        provider = queue_key.split("webhooks-", 1)[-1] if "webhooks-" in queue_key else "?"
        job_ids = redis_cmd("LRANGE", f"{queue_key}:wait", "0", "-1").split("\n")
        job_ids = [j.strip() for j in job_ids if j.strip()]

        for job_id in job_ids[:20]:
            data_raw = redis_cmd("HGET", f"{queue_key}:{job_id}", "data")
            if not data_raw:
                items.append({"id": job_id, "provider": provider,
                              "context": {"id": "?", "title": "?", "status": "?"}})
                continue
            try:
                payload = unwrap_job_payload(data_raw)
                items.append({"id": job_id, "provider": provider,
                              "context": extract_context_from_payload(provider, payload)})
            except Exception:
                items.append({"id": job_id, "provider": provider,
                              "context": {"id": "?", "title": "?", "status": "?"}})
    return items


def get_active_jobs():
    """Read currently active jobs from all queues."""
    active = []
    for queue_key in get_queue_names():
        provider = queue_key.split("webhooks-", 1)[-1] if "webhooks-" in queue_key else "?"
        job_ids = redis_cmd("LRANGE", f"{queue_key}:active", "0", "0").split("\n")
        job_ids = [j.strip() for j in job_ids if j.strip()]
        if not job_ids:
            continue
        job_id = job_ids[0]
        data_raw = redis_cmd("HGET", f"{queue_key}:{job_id}", "data")
        if not data_raw:
            active.append({"id": job_id, "provider": provider,
                           "context": {"id": "?", "title": "?", "status": "?"}})
            continue
        try:
            payload = unwrap_job_payload(data_raw)
            active.append({"id": job_id, "provider": provider,
                           "context": extract_context_from_payload(provider, payload)})
        except Exception:
            active.append({"id": job_id, "provider": provider,
                           "context": {"id": "?", "title": "?", "status": "?"}})
    return active


def extract_context_from_payload(provider, payload):
    """Extract display context from a webhook payload. Provider-agnostic fallback."""
    if not isinstance(payload, dict):
        return {"id": "?", "title": "?", "status": "?"}

    # Jira
    issue = payload.get("issue", {})
    if issue:
        fields = issue.get("fields", {})
        return {
            "id": issue.get("key", "?"),
            "title": (fields.get("summary", "?") or "?")[:60],
            "status": fields.get("status", {}).get("name", "?"),
        }

    # GitHub
    pr = payload.get("pull_request")
    gh_issue = payload.get("issue")
    repo = payload.get("repository", {}).get("full_name", "")
    if pr:
        return {
            "id": f"{repo}#{pr.get('number', '?')}",
            "title": (pr.get("title", "?") or "?")[:60],
            "status": payload.get("action", "?"),
        }
    if gh_issue:
        return {
            "id": f"{repo}#{gh_issue.get('number', '?')}",
            "title": (gh_issue.get("title", "?") or "?")[:60],
            "status": payload.get("action", "?"),
        }

    # Generic fallback
    return {"id": "?", "title": "?", "status": "?"}


# ── Log parsing ──

def parse_log_tail(n=500):
    """Parse the last N lines of the clawndom log into structured records."""
    try:
        result = subprocess.run(["tail", f"-{n}", LOG_FILE], capture_output=True, text=True)
        entries = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries
    except Exception:
        return []


def get_completed_jobs(entries, n=8):
    """Extract recently completed/failed jobs from log entries."""
    contexts = {}
    completions = {}

    for d in entries:
        job_id = d.get("jobId")
        if not job_id:
            continue
        msg = d.get("msg", "")
        if "Webhook context" in msg:
            contexts[job_id] = {
                "id": d.get("contextId", "?"),
                "title": d.get("contextTitle", "?"),
                "status": d.get("contextStatus", "?"),
            }
        elif "Routing matched" in msg:
            if job_id in contexts:
                contexts[job_id]["template"] = d.get("template", "")
        elif "Agent run completed" in msg:
            completions[job_id] = {"time": d.get("time", 0), "result": "completed"}
        elif "permanently failed" in msg:
            completions[job_id] = {
                "time": d.get("time", 0), "result": "failed",
                "error": d.get("error", "")[:40],
            }
        elif "no-match" in msg and "skipping" in msg or "No routing match" in msg:
            completions[job_id] = {"time": d.get("time", 0), "result": "skipped"}

    results = []
    for job_id, comp in sorted(completions.items(), key=lambda x: x[1]["time"], reverse=True)[:n]:
        ctx = contexts.get(job_id, {"id": "?", "title": "?", "status": "?"})
        results.append({"job_id": job_id, "context": ctx, **comp})
    return results


def get_runner_activity(entries):
    """Extract current runner activity from log stream events."""
    info = {
        "active": False,
        "phase": "",
        "latest": "",
        "elapsed": "",
        "tool": "",
        "turns": 0,
        "cost": 0,
    }

    spawn_time = None
    last_event_time = None

    for d in entries:
        msg = d.get("msg", "")
        event = d.get("event", "")
        t = d.get("time", 0)

        if "Spawning Claude CLI" in msg:
            spawn_time = t
            info["phase"] = "starting"
            info["latest"] = ""
            info["tool"] = ""

        if event == "assistant_text":
            last_event_time = t
            info["latest"] = msg.strip()[:100]
            info["phase"] = "thinking"

        elif event == "tool_call":
            last_event_time = t
            info["tool"] = d.get("tool", "?")
            info["phase"] = f"using {info['tool']}"

        elif event == "result":
            info["phase"] = "done"
            info["turns"] = d.get("turns", 0)
            info["cost"] = d.get("cost", 0)
            last_event_time = t

        if "Claude CLI completed" in msg:
            info["active"] = False
            info["phase"] = "done"
        elif "Claude CLI failed" in msg:
            info["active"] = False
            info["phase"] = "failed"

    if spawn_time and last_event_time:
        age_seconds = (time.time() * 1000 - last_event_time) / 1000
        info["active"] = age_seconds < 30

        elapsed_ms = last_event_time - spawn_time
        m, s = divmod(int(elapsed_ms / 1000), 60)
        info["elapsed"] = f"{m}m {s}s"

    return info if spawn_time else None


def format_time(epoch_ms):
    if not epoch_ms:
        return ""
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).astimezone().strftime("%H:%M")


# ── Render ──

def render(once=False):
    health = get_health()
    active_jobs = get_active_jobs()
    queue = get_queue_items()
    entries = parse_log_tail(500)
    completed = get_completed_jobs(entries, 8)
    activity = get_runner_activity(entries)
    now = datetime.now().strftime("%H:%M:%S")

    hc = GREEN if health == "healthy" else (YELLOW if health == "degraded" else RED)
    lines = []
    lines.append(f"{BOLD}{'═' * 74}{RESET}")
    lines.append(f"{BOLD}  CLAWNDOM{RESET}   {hc}{health}{RESET}   "
                 f"Active: {CYAN}{len(active_jobs)}{RESET}   "
                 f"Queue: {YELLOW}{len(queue)}{RESET}   "
                 f"{DIM}{now}{RESET}")
    lines.append(f"{BOLD}{'═' * 74}{RESET}")

    # ── ACTIVE ──
    lines.append("")
    if active_jobs:
        for job in active_jobs:
            ctx = job["context"]
            phase = f"{CYAN}processing{RESET}"
            elapsed = ""

            if activity and activity["phase"] and activity["phase"] != "done":
                phase = f"{CYAN}{activity['phase']}{RESET}"
                if activity["elapsed"]:
                    elapsed = f" {DIM}({activity['elapsed']}){RESET}"

            lines.append(f"  {GREEN}▶{RESET}  {BOLD}{ctx['id']}{RESET}  [{ctx['status']}]  {phase}{elapsed}")
            lines.append(f"     {ctx['title']}")
            if activity and activity["latest"] and activity["phase"] != "done":
                lines.append(f"     {DIM}{activity['latest'][:70]}{RESET}")
    else:
        lines.append(f"  {DIM}No active job — idle{RESET}")

    # ── QUEUE ──
    if queue:
        lines.append("")
        lines.append(f"  {BOLD}QUEUE{RESET} {DIM}({len(queue)} waiting){RESET}")
        for i, item in enumerate(queue[:10]):
            ctx = item["context"]
            num = f"{i + 1}."
            lines.append(f"  {DIM}{num:>4}{RESET}  {ctx['id']:<12} [{ctx['status'][:20]}]  {ctx['title'][:40]}")

    # ── RECENT ──
    if completed:
        lines.append("")
        lines.append(f"  {BOLD}RECENT{RESET}")
        for item in completed:
            ctx = item["context"]
            result = item.get("result", "?")
            t = format_time(item.get("time"))

            if result == "completed":
                icon = f"{GREEN}✓{RESET}"
            elif result == "failed":
                icon = f"{RED}✗{RESET}"
            elif result == "skipped":
                icon = f"{DIM}–{RESET}"
            else:
                icon = " "

            err = ""
            if result == "failed" and item.get("error"):
                err = f"  {RED}{item['error'][:30]}{RESET}"

            cid = ctx.get("id", "")
            title = ctx.get("title", "")
            if cid == "?" and title == "?":
                continue

            lines.append(f"  {icon}  {t:>5}  {cid:<12} {title[:45]}{err}")

    lines.append("")
    if not once:
        lines.append(f"  {DIM}Refreshing every {REFRESH_SECONDS}s  |  Ctrl+C to exit{RESET}")

    print(CLEAR + "\n".join(lines))


def main():
    once = "--once" in sys.argv
    try:
        while True:
            render(once)
            if once:
                break
            time.sleep(REFRESH_SECONDS)
    except KeyboardInterrupt:
        print(f"\n{DIM}Dashboard stopped.{RESET}")


if __name__ == "__main__":
    main()
