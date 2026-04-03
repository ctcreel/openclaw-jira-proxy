#!/usr/bin/env python3
"""
Clawndom Dashboard — real-time view of webhook processing and Patch's work.

Usage: python3 scripts/dashboard.py
       python3 scripts/dashboard.py --once  (single snapshot, no refresh)
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

LOG_FILE = "/usr/local/var/log/clawndom.log"
SESSIONS_DIR = "/Users/ctcreel/.openclaw/agents/patch/sessions"
HEALTH_URL = "http://127.0.0.1:8793/api/health"
REDIS_QUEUE = "bull:webhooks-jira"
REFRESH_SECONDS = 5

CLEAR = "\033[2J\033[H"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
RESET = "\033[0m"


# ── Provider-specific context extraction (mirrors src/strategies/context.ts) ──

def extract_jira_context(payload):
    issue = payload.get("issue", {})
    fields = issue.get("fields", {})
    return {
        "id": issue.get("key", "?"),
        "title": (fields.get("summary", "?") or "?")[:60],
        "status": fields.get("status", {}).get("name", "?"),
        "source": "jira",
    }


def extract_github_context(payload):
    repo = payload.get("repository", {}).get("full_name", "?")
    action = payload.get("action", "?")
    pr = payload.get("pull_request")
    issue = payload.get("issue")

    if pr:
        return {
            "id": f"{repo}#{pr.get('number', '?')}",
            "title": (pr.get("title", "?") or "?")[:60],
            "status": action,
            "source": "github",
        }
    if issue:
        return {
            "id": f"{repo}#{issue.get('number', '?')}",
            "title": (issue.get("title", "?") or "?")[:60],
            "status": action,
            "source": "github",
        }
    return {"id": repo, "title": "push", "status": action, "source": "github"}


def extract_context(provider, payload):
    extractors = {"jira": extract_jira_context, "github": extract_github_context}
    extractor = extractors.get(provider)
    if extractor:
        try:
            return extractor(payload)
        except Exception:
            pass
    return {"id": "?", "title": "?", "status": "?", "source": provider or "?"}


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


def unwrap_job_payload(data_raw):
    """Unwrap BullMQ job data which may be multi-layered JSON strings."""
    data = json.loads(data_raw)
    # BullMQ stores data as a JSON string, so first parse may yield a string
    while isinstance(data, str):
        data = json.loads(data)
    # Data might be an envelope {payload, attempt} or raw payload
    if isinstance(data, dict) and "payload" in data:
        payload = data["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return payload
    return data


def get_queue_items():
    """Read pending jobs from Redis BullMQ queue with context."""
    items = []
    # Waiting jobs
    job_ids = redis_cmd("LRANGE", f"{REDIS_QUEUE}:wait", "0", "-1").split("\n")
    job_ids = [j.strip() for j in job_ids if j.strip()]

    for job_id in job_ids[:20]:
        data_raw = redis_cmd("HGET", f"{REDIS_QUEUE}:{job_id}", "data")
        if not data_raw:
            items.append({"id": job_id, "context": {"id": "?", "title": "?", "status": "?", "source": "?"}})
            continue
        try:
            payload = unwrap_job_payload(data_raw)
            items.append({"id": job_id, "context": extract_context("jira", payload)})
        except Exception:
            items.append({"id": job_id, "context": {"id": "?", "title": "?", "status": "?", "source": "?"}})

    return items


def get_active_job():
    """Read the currently active job from Redis."""
    job_ids = redis_cmd("LRANGE", f"{REDIS_QUEUE}:active", "0", "0").split("\n")
    job_ids = [j.strip() for j in job_ids if j.strip()]
    if not job_ids:
        return None

    job_id = job_ids[0]
    data_raw = redis_cmd("HGET", f"{REDIS_QUEUE}:{job_id}", "data")
    if not data_raw:
        return {"id": job_id, "context": {"id": "?", "title": "?", "status": "?", "source": "?"}}
    try:
        payload = unwrap_job_payload(data_raw)
        return {"id": job_id, "context": extract_context("jira", payload)}
    except Exception:
        return {"id": job_id, "context": {"id": "?", "title": "?", "status": "?", "source": "?"}}


def get_completed_jobs(n=5):
    """Read recently completed jobs from Clawndom logs."""
    completed = []
    try:
        result = subprocess.run(["tail", "-300", LOG_FILE], capture_output=True, text=True)
        # Collect context and completion info by job ID
        contexts = {}
        completions = {}
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            job_id = d.get("jobId")
            if not job_id:
                continue
            msg = d.get("msg", "")
            if "Webhook context" in msg:
                contexts[job_id] = {
                    "id": d.get("contextId", "?"),
                    "title": d.get("contextTitle", "?"),
                    "status": d.get("contextStatus", "?"),
                    "source": d.get("contextSource", "?"),
                    "template": "",
                }
            elif "Routing matched" in msg:
                if job_id in contexts:
                    contexts[job_id]["template"] = d.get("template", "")
            elif "Agent run completed — job complete" in msg:
                completions[job_id] = {"time": d.get("time", 0), "result": "completed"}
            elif "permanently failed" in msg:
                completions[job_id] = {
                    "time": d.get("time", 0),
                    "result": "failed",
                    "error": d.get("error", "")[:40],
                }
            elif "no-match" in msg and "skipping" in msg:
                completions[job_id] = {"time": d.get("time", 0), "result": "skipped"}

        for job_id, comp in sorted(completions.items(), key=lambda x: x[1]["time"], reverse=True)[:n]:
            ctx = contexts.get(job_id, {"id": "?", "title": "?", "status": "?", "source": "?"})
            completed.append({"job_id": job_id, "context": ctx, **comp})

    except Exception:
        pass
    return completed


def get_patch_session():
    """Extract what Patch is currently doing from her latest session."""
    try:
        files = sorted(
            [os.path.join(SESSIONS_DIR, f) for f in os.listdir(SESSIONS_DIR)
             if f.endswith(".jsonl") and not f.endswith(".lock")],
            key=os.path.getmtime, reverse=True,
        )
        if not files:
            return None

        latest = files[0]
        age = time.time() - os.path.getmtime(latest)
        size = os.path.getsize(latest)

        info = {
            "active": age < 60,
            "age": age,
            "size": size,
            "phase": "starting",
            "steps": [],
            "latest": "",
            "elapsed": "",
            "subprocess": False,
        }

        session_start = None
        with open(latest) as fh:
            for line in fh:
                d = json.loads(line)
                if d.get("type") == "session":
                    session_start = d.get("timestamp")
                if d.get("type") != "message":
                    continue
                role = d.get("message", {}).get("role", "")
                content = d.get("message", {}).get("content", "")

                if role == "assistant" and isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "text" and block.get("text", "").strip():
                            text = block["text"].strip()
                            info["latest"] = text[:100]
                            tl = text.lower()
                            if "assign" in tl and "transition" in tl:
                                info["phase"] = "assigning + transitioning"
                                info["steps"].append("assigned")
                            elif "business value" in tl and "blocked" in tl:
                                info["phase"] = "BLOCKED (no business value)"
                            elif "plan" in tl and ("read" in tl or "approved" in tl or "fetch" in tl):
                                info["phase"] = "reading plan"
                                if "plan read" not in info["steps"]:
                                    info["steps"].append("plan read")
                            elif "branch" in tl and ("creat" in tl or "checkout" in tl or "set up" in tl):
                                info["phase"] = "setting up branch"
                                if "branch" not in info["steps"]:
                                    info["steps"].append("branch")
                            elif "claude code" in tl or "spawn" in tl or "sessions_spawn" in tl:
                                info["phase"] = "Claude Code spawned"
                                if "spawned" not in info["steps"]:
                                    info["steps"].append("spawned")
                            elif "still running" in tl or "waiting" in tl or "pid" in tl.split("(")[0]:
                                info["phase"] = "Claude Code implementing"
                                info["subprocess"] = True
                            elif "review" in tl and ("output" in tl or "diff" in tl):
                                info["phase"] = "reviewing output"
                                if "reviewed" not in info["steps"]:
                                    info["steps"].append("reviewed")
                            elif ("pr " in tl or "pull request" in tl) and "creat" in tl:
                                info["phase"] = "opening PR"
                                if "PR" not in info["steps"]:
                                    info["steps"].append("PR")
                            elif "scarlett" in tl:
                                info["phase"] = "Scarlett review"
                                if "Scarlett" not in info["steps"]:
                                    info["steps"].append("Scarlett")
                            elif "no_reply" in text or "NO_REPLY" in text:
                                info["phase"] = "done"
                            elif "merging" in tl or "gh pr merge" in tl:
                                info["phase"] = "merging PR"
                            elif "gate" in tl and "blocked" in tl:
                                info["phase"] = "gate blocked"

                if "still running" in str(content).lower():
                    info["subprocess"] = True

        if session_start:
            try:
                start = datetime.fromisoformat(session_start.replace("Z", "+00:00"))
                elapsed = datetime.now(timezone.utc) - start
                m, s = divmod(int(elapsed.total_seconds()), 60)
                info["elapsed"] = f"{m}m {s}s"
            except Exception:
                pass

        return info
    except Exception:
        return None


def format_time(epoch_ms):
    if not epoch_ms:
        return ""
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).astimezone().strftime("%H:%M")


# ── Render ──

def render(once=False):
    health = get_health()
    active_job = get_active_job()
    queue = get_queue_items()
    completed = get_completed_jobs(8)
    session = get_patch_session()
    now = datetime.now().strftime("%H:%M:%S")

    hc = GREEN if health == "healthy" else RED
    lines = []
    lines.append(f"{BOLD}{'═' * 74}{RESET}")
    active_count = 1 if active_job else 0
    lines.append(f"{BOLD}  CLAWNDOM{RESET}   {hc}{health}{RESET}   "
                 f"Active: {CYAN}{active_count}{RESET}   "
                 f"Queue: {YELLOW}{len(queue)}{RESET}   "
                 f"{DIM}{now}{RESET}")
    lines.append(f"{BOLD}{'═' * 74}{RESET}")

    # ── ACTIVE ──
    lines.append("")
    if active_job:
        ctx = active_job["context"]
        phase = ""
        if session and session["active"]:
            phase = session["phase"]
            if session["subprocess"]:
                phase = f"{MAGENTA}Claude Code implementing{RESET}"
            elif "BLOCKED" in phase:
                phase = f"{RED}{phase}{RESET}"
            else:
                phase = f"{CYAN}{phase}{RESET}"
            elapsed = f" {DIM}({session['elapsed']}){RESET}" if session["elapsed"] else ""
        else:
            phase = f"{CYAN}processing{RESET}"
            elapsed = ""

        template = f"  {DIM}via {ctx.get('template', '?')}{RESET}" if ctx.get("template") else ""
        lines.append(f"  {GREEN}▶{RESET}  {BOLD}{ctx['id']}{RESET}  [{ctx['status']}]  {phase}{elapsed}{template}")
        lines.append(f"     {ctx['title']}")
        if session and session.get("latest") and session["active"]:
            lines.append(f"     {DIM}{session['latest'][:70]}{RESET}")
    else:
        lines.append(f"  {DIM}No active job — Patch is idle{RESET}")

    # ── QUEUE ──
    if queue:
        lines.append("")
        lines.append(f"  {BOLD}QUEUE{RESET} {DIM}({len(queue)} waiting){RESET}")
        for i, item in enumerate(queue[:10]):
            ctx = item["context"]
            num = f"{i + 1}."
            lines.append(f"  {DIM}{num:>4}{RESET}  {ctx['id']:<12} [{ctx['status'][:20]}]  {ctx['title'][:40]}")

    # ── COMPLETED (only from current PID's logs) ──
    if completed:
        # Filter to only show jobs from the current Clawndom process
        # by checking if timestamps are after the last restart
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

            cid = ctx["id"] if ctx["id"] != "?" else ""
            title = ctx["title"] if ctx["title"] != "?" else ""
            # Skip entries with no meaningful context
            if cid == "" and title == "":
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
