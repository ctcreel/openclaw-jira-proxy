#!/usr/bin/env python3
"""
Clawndom Dashboard — live view of webhook processing via SSE.

Consumes the typed event stream from /api/events (SPE-1706) and renders a
terminal dashboard. No Redis access, no log-file tail — everything comes
off the wire.

Usage:
    CLAWNDOM_URL=https://clawndom.tail708f46.ts.net python3 scripts/dashboard.py
    python3 scripts/dashboard.py --once          # single snapshot (prints then exits)
    python3 scripts/dashboard.py --url http://localhost:8793

Env vars:
    CLAWNDOM_URL   Base URL of the Clawndom instance (default: http://127.0.0.1:8793)
    CLAWNDOM_TOKEN Optional bearer token if /api/events ever grows auth
"""

import argparse
import json
import os
import signal
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

DEFAULT_URL = "http://127.0.0.1:8793"
HEALTH_REFRESH_SECONDS = 10
RECENT_MAX = 12
ACTIVE_STALE_SECONDS = 30  # treat a runner as "live" only if it emitted within this window
TOOL_HISTORY_MAX = 8  # rolling tool-call buffer per active job
TEXT_HISTORY_MAX = 3  # rolling assistant-text buffer per active job
TICKET_HISTORY_MAX = 6  # recent runs shown per ticket

# ANSI
CLEAR = "\033[2J\033[H"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
RESET = "\033[0m"


# ── Shared state ──────────────────────────────────────────────────────
class State:
    """Mutable state updated by the SSE reader, read by the renderer."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.health: str = "unknown"
        self.health_checked_at: float = 0.0
        # traceId → latest context from webhook.accepted
        self.trace_context: dict[str, dict[str, str]] = {}
        # jobId → traceId (populated by job.queued / job.started)
        self.job_trace: dict[str, str] = {}
        # jobId → queued job dict (cleared on job.started or job.failed/completed)
        self.queued: dict[str, dict[str, Any]] = {}
        # jobId → active job dict (tool_history + text_history deques live inside)
        self.active: dict[str, dict[str, Any]] = {}
        # recent outcomes, newest first (completed / failed / non-routing rejects only)
        self.recent: deque[dict[str, Any]] = deque(maxlen=RECENT_MAX)
        # contextId → deque of {kind, time, status, job_id} most-recent-first; lets
        # the dashboard answer "what has she done on SPE-1709?" without log grep.
        self.ticket_history: dict[str, deque[dict[str, Any]]] = {}
        # Jira fan-out webhooks that don't match any routing rule (e.g. a
        # comment-added event on a ticket whose state Patch doesn't care
        # about). Counted, not listed — otherwise they drown real work.
        self.routing_skipped_count: int = 0
        self.routing_skipped_last_time: int = 0
        # wall-clock of last SSE event received
        self.last_event_at: float = 0.0
        # Whether the SSE reader is connected
        self.sse_connected: bool = False
        self.sse_error: str = ""


STATE = State()


# ── Tool-call detail extraction ──────────────────────────────────────
_MCP_ARG_PRIORITY = (
    "issueIdOrKey",
    "issue_key",
    "channel",
    "thread_ts",
    "ts",
    "user",
    "query",
    "jql",
    "documentId",
    "spreadsheetId",
    "path",
)

_FILE_TOOLS = {"Read", "Write", "Edit", "NotebookEdit"}


def _shorten_path(path: str) -> str:
    """Keep the last two path segments — enough to disambiguate without a full
    absolute path. `/home/clawndom/.clawndom/.../templates/jira-plan-bug.md`
    becomes `templates/jira-plan-bug.md`."""
    if "/" not in path:
        return path
    parts = path.rsplit("/", 2)
    return "/".join(parts[-2:]) if len(parts) >= 2 else path


def describe_tool_call(tool: str, args: Any) -> str:
    """Render a short detail string for a tool call so `Read` shows WHAT was
    read. Falls back to empty if args are missing — the renderer will just
    show the tool name on its own."""
    if not isinstance(args, dict):
        return ""

    if tool == "Bash":
        command = args.get("command", "")
        if isinstance(command, str):
            return command.split("\n", 1)[0][:60]
    elif tool in _FILE_TOOLS:
        path = args.get("file_path") or args.get("notebook_path", "")
        if isinstance(path, str) and path:
            return _shorten_path(path)
    elif tool == "Grep":
        pattern = str(args.get("pattern", ""))
        scope = args.get("glob") or args.get("type") or args.get("path", "")
        return f"{pattern[:35]}{f' in {scope}' if scope else ''}"[:55]
    elif tool == "Glob":
        return str(args.get("pattern", ""))[:55]
    elif tool == "ToolSearch":
        query = str(args.get("query", ""))
        if query.startswith("select:"):
            names = [n for n in query[len("select:") :].split(",") if n]
            if len(names) == 1:
                # Show the tool suffix after the last `__` — that's the
                # semantically meaningful part (getJiraIssue, createEvent).
                return f"load {names[0].rsplit('__', 1)[-1]}"
            return f"load {len(names)} tools"
        return query[:55]
    elif tool == "Agent":
        subagent = args.get("subagent_type", "agent")
        description = args.get("description", "")
        return f"{subagent}: {description}"[:55]
    elif tool == "TodoWrite":
        todos = args.get("todos", [])
        return f"{len(todos)} todos" if isinstance(todos, list) else ""
    elif tool.startswith("mcp__"):
        for key in _MCP_ARG_PRIORITY:
            value = args.get(key)
            if isinstance(value, (str, int)):
                return f"{key}={value}"[:55]
        for key, value in args.items():
            if key == "cloudId":
                continue
            if isinstance(value, str) and value:
                return f"{key}={value[:40]}"
    return ""


# ── Event handlers ───────────────────────────────────────────────────
def _new_active_entry(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "started_at": payload.get("timestamp", 0),
        "agent_id": payload.get("agentId", "?"),
        "template": payload.get("template"),
        "runner": payload.get("runner", "?"),
        "model": payload.get("model"),
        "provider": payload.get("provider", "?"),
        "phase": "starting",
        "tool": "",
        "latest": "",
        "tool_history": deque(maxlen=TOOL_HISTORY_MAX),
        "text_history": deque(maxlen=TEXT_HISTORY_MAX),
        "last_event_at": time.time(),
        "turns": 0,
        "cost": 0.0,
    }


def _record_ticket_event(context_id: str, entry: dict[str, Any]) -> None:
    if not context_id or context_id == "?":
        return
    history = STATE.ticket_history.setdefault(
        context_id, deque(maxlen=TICKET_HISTORY_MAX)
    )
    history.appendleft(entry)


def handle_event(event_type: str, payload: dict[str, Any]) -> None:
    trace_id = payload.get("traceId", "")
    job_id = payload.get("jobId", "")

    with STATE.lock:
        STATE.last_event_at = time.time()

        if event_type == "webhook.accepted":
            STATE.trace_context[trace_id] = {
                "id": payload.get("contextId", "?"),
                "title": payload.get("contextTitle", "?"),
                "status": payload.get("contextStatus", "?"),
                "provider": payload.get("provider", "?"),
            }

        elif event_type == "webhook.rejected":
            reason = payload.get("reason", "?")
            # Jira fan-out noise — these fire constantly on any ticket edit
            # whose new status doesn't match a routing rule. Count them so
            # we're not lying about the volume, but keep them out of RECENT
            # so real work stays visible.
            if reason == "no-routing-match":
                STATE.routing_skipped_count += 1
                STATE.routing_skipped_last_time = payload.get("timestamp", 0)
            else:
                STATE.recent.appendleft(
                    {
                        "kind": "rejected",
                        "time": payload.get("timestamp", 0),
                        "provider": payload.get("provider", "?"),
                        "reason": reason,
                    }
                )

        elif event_type == "job.queued":
            STATE.job_trace[job_id] = trace_id
            STATE.queued[job_id] = {
                "provider": payload.get("provider", "?"),
                "title": payload.get("contextTitle", "?"),
                "context_id": payload.get("contextId", "?"),
                "queued_at": payload.get("timestamp", 0),
            }

        elif event_type == "job.requeued":
            STATE.job_trace[job_id] = trace_id
            STATE.queued[job_id] = {
                "provider": payload.get("provider", "?"),
                "title": STATE.queued.get(job_id, {}).get("title", "?"),
                "context_id": STATE.queued.get(job_id, {}).get("context_id", "?"),
                "queued_at": payload.get("timestamp", 0),
                "attempt": payload.get("attempt", 1),
            }

        elif event_type == "job.started":
            STATE.job_trace[job_id] = trace_id
            STATE.queued.pop(job_id, None)
            STATE.active[job_id] = _new_active_entry(payload)

        elif event_type == "runner.assistant_text":
            if job_id in STATE.active:
                text = payload.get("text", "")
                STATE.active[job_id]["phase"] = "thinking"
                STATE.active[job_id]["latest"] = text[:120]
                STATE.active[job_id]["text_history"].appendleft(
                    {"time": payload.get("timestamp", 0), "text": text}
                )
                STATE.active[job_id]["last_event_at"] = time.time()

        elif event_type == "runner.tool_call":
            if job_id in STATE.active:
                tool = payload.get("tool", "?")
                detail = describe_tool_call(tool, payload.get("args"))
                STATE.active[job_id]["tool"] = tool
                STATE.active[job_id]["phase"] = f"tool: {tool}"
                STATE.active[job_id]["tool_history"].appendleft(
                    {"time": payload.get("timestamp", 0), "tool": tool, "detail": detail}
                )
                STATE.active[job_id]["last_event_at"] = time.time()

        elif event_type == "runner.result":
            if job_id in STATE.active:
                STATE.active[job_id]["turns"] = payload.get("turns", 0)
                STATE.active[job_id]["cost"] = payload.get("costUsd", 0.0)
                STATE.active[job_id]["phase"] = "finishing"
                STATE.active[job_id]["last_event_at"] = time.time()

        elif event_type == "job.completed":
            state = STATE.active.pop(job_id, None)
            ctx = STATE.trace_context.get(trace_id, {})
            completion = {
                "kind": "completed",
                "time": payload.get("timestamp", 0),
                "job_id": job_id,
                "context": ctx,
                "duration_ms": payload.get("durationMs", 0),
                "turns": state.get("turns", 0) if state else 0,
                "cost": state.get("cost", 0.0) if state else 0.0,
                "agent_id": state.get("agent_id", "?") if state else "?",
            }
            STATE.recent.appendleft(completion)
            _record_ticket_event(ctx.get("id", "?"), completion)

        elif event_type == "job.failed":
            # Always clear from active — a retry will arrive as a new jobId via
            # job.started, not as a continuation of this one. Previously we only
            # popped on `final` failures, which left non-final failures as
            # zombies in the active list forever.
            STATE.active.pop(job_id, None)
            ctx = STATE.trace_context.get(trace_id, {})
            if payload.get("final"):
                failure = {
                    "kind": "failed",
                    "time": payload.get("timestamp", 0),
                    "job_id": job_id,
                    "context": ctx,
                    "error": payload.get("error", "")[:60],
                    "attempt": payload.get("attempt", 0),
                }
                STATE.recent.appendleft(failure)
                _record_ticket_event(ctx.get("id", "?"), failure)
            # Non-final failures will be followed by a job.requeued event


# ── SSE reader ───────────────────────────────────────────────────────
def stream_events(url: str, stop_event: threading.Event) -> None:
    """Run the SSE reader in its own thread, auto-reconnecting on drop."""
    backoff = 1.0
    while not stop_event.is_set():
        try:
            request = urllib_request.Request(
                f"{url}/api/events",
                headers={"Accept": "text/event-stream", "Cache-Control": "no-cache"},
            )
            token = os.environ.get("CLAWNDOM_TOKEN")
            if token:
                request.add_header("Authorization", f"Bearer {token}")

            with urllib_request.urlopen(request, timeout=None) as stream:
                with STATE.lock:
                    STATE.sse_connected = True
                    STATE.sse_error = ""
                backoff = 1.0
                parse_sse_stream(stream, stop_event)

        except (urllib_error.URLError, OSError) as exc:
            with STATE.lock:
                STATE.sse_connected = False
                STATE.sse_error = f"{exc}"
        except Exception as exc:  # defensive — don't kill the thread on parse errors
            with STATE.lock:
                STATE.sse_connected = False
                STATE.sse_error = f"{exc}"

        if stop_event.is_set():
            return
        time.sleep(backoff)
        backoff = min(backoff * 2, 15.0)


def parse_sse_stream(stream: Any, stop_event: threading.Event) -> None:
    """Parse SSE framing: `event: foo\\ndata: {...}\\n\\n`."""
    current_event = "message"
    current_data: list[str] = []

    for raw in stream:
        if stop_event.is_set():
            return
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")

        if line == "":
            if current_data:
                payload_text = "\n".join(current_data)
                try:
                    payload = json.loads(payload_text)
                except json.JSONDecodeError:
                    payload = {}
                handle_event(current_event, payload)
            current_event = "message"
            current_data = []
            continue

        if line.startswith(":"):
            # Comment frame (keepalive). Still counts as a heartbeat.
            with STATE.lock:
                STATE.last_event_at = time.time()
            continue

        if line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            current_data.append(line[len("data:") :].lstrip())


# ── Health polling ───────────────────────────────────────────────────
def refresh_health(url: str) -> None:
    """Poll /api/health and stash the result. Cheap, bounded at HEALTH_REFRESH_SECONDS."""
    try:
        with urllib_request.urlopen(f"{url}/api/health", timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
        status = body.get("status", "unknown")
    except Exception:
        status = "unreachable"
    with STATE.lock:
        STATE.health = status
        STATE.health_checked_at = time.time()


def bootstrap_active_jobs(url: str) -> None:
    """Seed STATE.active from /api/jobs/active so jobs that started before
    the dashboard connected are visible. Merges into existing state — SSE
    events that already landed for a job take precedence."""
    try:
        with urllib_request.urlopen(f"{url}/api/jobs/active", timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return

    jobs = body.get("jobs", [])
    if not isinstance(jobs, list):
        return

    now = time.time()
    with STATE.lock:
        for job in jobs:
            job_id = job.get("jobId")
            trace_id = job.get("traceId", "")
            if not job_id or job_id in STATE.active:
                continue
            context = job.get("context") or {}
            STATE.trace_context.setdefault(
                trace_id,
                {
                    "id": context.get("id", "?"),
                    "title": context.get("title", "?"),
                    "status": context.get("status", "?"),
                    "provider": job.get("provider", "?"),
                },
            )
            STATE.job_trace[job_id] = trace_id
            STATE.active[job_id] = {
                "started_at": job.get("startedAt", 0),
                "agent_id": job.get("agentId", "?"),
                "template": job.get("template"),
                "runner": job.get("runner", "?"),
                "model": job.get("model"),
                "provider": job.get("provider", "?"),
                "phase": "starting",
                "tool": "",
                "latest": "",
                "tool_history": deque(maxlen=TOOL_HISTORY_MAX),
                "text_history": deque(maxlen=TEXT_HISTORY_MAX),
                "last_event_at": now,
                "turns": 0,
                "cost": 0.0,
            }


# ── Render ───────────────────────────────────────────────────────────
def format_time(epoch_ms: int) -> str:
    if not epoch_ms:
        return ""
    return (
        datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
        .astimezone()
        .strftime("%H:%M:%S")
    )


def health_color(status: str) -> str:
    if status == "healthy":
        return GREEN
    if status == "degraded":
        return YELLOW
    return RED


def _format_elapsed(seconds: float) -> str:
    return (
        f"{int(seconds // 60)}m {int(seconds % 60)}s"
        if seconds > 60
        else f"{int(seconds)}s"
    )


def _render_header(
    url: str,
    health: str,
    sse_connected: bool,
    active_count: int,
    queued_count: int,
    skipped_count: int,
    skipped_last_time: int,
) -> list[str]:
    hc = health_color(health)
    sse_state = f"{GREEN}SSE{RESET}" if sse_connected else f"{RED}SSE down{RESET}"
    now_text = datetime.now().strftime("%H:%M:%S")
    skipped_suffix = ""
    if skipped_count > 0:
        last = format_time(skipped_last_time) if skipped_last_time else "—"
        skipped_suffix = (
            f"   {DIM}Skipped webhooks: {skipped_count} (last {last}){RESET}"
        )
    return [
        f"{BOLD}{'═' * 80}{RESET}",
        (
            f"{BOLD}  CLAWNDOM{RESET}   {hc}{health}{RESET}   {sse_state}   "
            f"Active: {CYAN}{active_count}{RESET}   "
            f"Queued: {YELLOW}{queued_count}{RESET}{skipped_suffix}   "
            f"{DIM}{url}   {now_text}{RESET}"
        ),
        f"{BOLD}{'═' * 80}{RESET}",
    ]


def _render_active_job(
    job_id: str,
    job: dict[str, Any],
    job_trace: dict[str, str],
    trace_context: dict[str, dict[str, str]],
) -> list[str]:
    trace_id = job_trace.get(job_id, "")
    ctx = trace_context.get(trace_id, {"id": "?", "title": "?", "status": "?"})
    elapsed_seconds = (time.time() * 1000 - job["started_at"]) / 1000
    elapsed_text = _format_elapsed(elapsed_seconds)
    is_stale = (time.time() - job["last_event_at"]) > ACTIVE_STALE_SECONDS
    phase = job["phase"]
    phase_color = YELLOW if is_stale else CYAN
    model = job.get("model")
    model_suffix = f" {DIM}[{model}]{RESET}" if model else ""
    stale_marker = (
        f" {DIM}(no runner events for {ACTIVE_STALE_SECONDS}s){RESET}" if is_stale else ""
    )

    lines: list[str] = [
        (
            f"  {GREEN}▶{RESET}  {BOLD}{ctx['id']:<14}{RESET}"
            f"[{ctx.get('status', '?')}]  → {job['agent_id']}{model_suffix}  "
            f"{phase_color}{phase}{RESET}  {DIM}({elapsed_text}){RESET}{stale_marker}"
        )
    ]
    title = ctx.get("title") or "?"
    if title != "?":
        lines.append(f"     {DIM}{title[:72]}{RESET}")

    tool_history = list(job.get("tool_history") or ())
    if tool_history:
        lines.append(f"     {DIM}tools:{RESET}")
        for entry in tool_history:
            tool_name = entry["tool"]
            detail = entry.get("detail", "")
            timestamp = format_time(entry.get("time", 0))
            detail_text = f"  {detail}" if detail else ""
            lines.append(
                f"       {DIM}{timestamp}{RESET}  {MAGENTA}{tool_name:<16}{RESET}"
                f"{DIM}{detail_text[:56]}{RESET}"
            )

    text_history = list(job.get("text_history") or ())
    if text_history:
        lines.append(f"     {DIM}said:{RESET}")
        for entry in text_history:
            text = (entry.get("text") or "").replace("\n", " ")
            timestamp = format_time(entry.get("time", 0))
            lines.append(f"       {DIM}{timestamp}  \u201c{text[:60]}\u2026\u201d{RESET}")

    return lines


def _render_queued(queued: list[tuple[str, dict[str, Any]]]) -> list[str]:
    if not queued:
        return []
    lines = ["", f"  {BOLD}QUEUED{RESET} {DIM}({len(queued)} waiting){RESET}"]
    for _job_id, job in queued[:8]:
        attempt_suffix = (
            f" {DIM}retry {job['attempt']}{RESET}" if job.get("attempt") else ""
        )
        lines.append(
            f"     {job['context_id']:<14} {DIM}{job['provider']}{RESET}  "
            f"{(job.get('title') or '?')[:50]}{attempt_suffix}"
        )
    return lines


def _render_recent(recent: list[dict[str, Any]]) -> list[str]:
    if not recent:
        return []
    lines = ["", f"  {BOLD}RECENT{RESET}"]
    for item in recent:
        kind = item["kind"]
        timestamp = format_time(item.get("time", 0))
        if kind == "completed":
            ctx = item.get("context", {})
            duration_seconds = item.get("duration_ms", 0) / 1000
            detail = (
                f"{duration_seconds:.1f}s  {item.get('turns', 0)} turns  "
                f"${item.get('cost', 0.0):.3f}"
            )
            cid = ctx.get("id", "?")
            title = (ctx.get("title") or "?")[:40]
            lines.append(
                f"  {GREEN}\u2713{RESET}  {timestamp}  {cid:<14} {title:<42} {DIM}{detail}{RESET}"
            )
        elif kind == "failed":
            ctx = item.get("context", {})
            cid = ctx.get("id", "?")
            title = (ctx.get("title") or "?")[:40]
            error = item.get("error", "")
            lines.append(
                f"  {RED}\u2717{RESET}  {timestamp}  {cid:<14} {title:<42} {RED}{error[:30]}{RESET}"
            )
        elif kind == "rejected":
            lines.append(
                f"  {DIM}\u2013  {timestamp}  {item.get('provider', '?'):<14} "
                f"{item.get('reason', '?')}{RESET}"
            )
    return lines


def _render_tickets(ticket_history: dict[str, deque[dict[str, Any]]]) -> list[str]:
    if not ticket_history:
        return []
    # Sort by most recent outcome in each ticket — the ones Patch touched
    # last show first, matching what an operator cares about.
    sortable = [
        (max((entry.get("time", 0) for entry in entries), default=0), ticket_id, entries)
        for ticket_id, entries in ticket_history.items()
    ]
    sortable.sort(key=lambda row: row[0], reverse=True)
    lines = ["", f"  {BOLD}TICKETS{RESET} {DIM}(this session){RESET}"]
    for _latest, ticket_id, entries in sortable[:8]:
        outcomes: list[str] = []
        for entry in list(entries)[:4]:
            timestamp = format_time(entry.get("time", 0))
            if entry["kind"] == "completed":
                outcomes.append(f"{GREEN}\u2713{RESET}{DIM} {timestamp}{RESET}")
            else:
                outcomes.append(f"{RED}\u2717{RESET}{DIM} {timestamp}{RESET}")
        # Pull the most recent outcome's title for context on the right.
        latest_entry = list(entries)[0]
        title = ((latest_entry.get("context") or {}).get("title") or "")[:40]
        lines.append(f"     {ticket_id:<14} {'  '.join(outcomes)}   {DIM}{title}{RESET}")
    return lines


def render(url: str) -> str:
    with STATE.lock:
        health = STATE.health
        active = list(STATE.active.items())
        queued = list(STATE.queued.items())
        recent = list(STATE.recent)
        trace_context = STATE.trace_context.copy()
        job_trace = STATE.job_trace.copy()
        ticket_history = {k: v.copy() for k, v in STATE.ticket_history.items()}
        skipped_count = STATE.routing_skipped_count
        skipped_last_time = STATE.routing_skipped_last_time
        sse_connected = STATE.sse_connected
        sse_error = STATE.sse_error

    lines = _render_header(
        url=url,
        health=health,
        sse_connected=sse_connected,
        active_count=len(active),
        queued_count=len(queued),
        skipped_count=skipped_count,
        skipped_last_time=skipped_last_time,
    )

    if not sse_connected and sse_error:
        lines.append(f"  {RED}SSE reader error: {sse_error[:70]}{RESET}")

    lines.append("")
    if active:
        for job_id, job in active:
            lines.extend(_render_active_job(job_id, job, job_trace, trace_context))
    else:
        lines.append(f"  {DIM}No active jobs — idle{RESET}")

    lines.extend(_render_queued(queued))
    lines.extend(_render_recent(recent))
    lines.extend(_render_tickets(ticket_history))

    lines.append("")
    lines.append(f"  {DIM}Ctrl+C to exit.{RESET}")

    return CLEAR + "\n".join(lines) + "\n"


# ── Main loop ────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="print one snapshot then exit")
    parser.add_argument(
        "--url",
        default=os.environ.get("CLAWNDOM_URL", DEFAULT_URL),
        help="base URL (default: $CLAWNDOM_URL or http://127.0.0.1:8793)",
    )
    parser.add_argument(
        "--interval", type=float, default=1.0, help="render refresh interval in seconds"
    )
    args = parser.parse_args()

    url = args.url.rstrip("/")

    if args.once:
        # One-shot: fetch health synchronously, render whatever state we have.
        refresh_health(url)
        bootstrap_active_jobs(url)
        sys.stdout.write(render(url))
        sys.stdout.flush()
        return 0

    stop_event = threading.Event()

    def handle_sigint(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigint)

    sse_thread = threading.Thread(target=stream_events, args=(url, stop_event), daemon=True)
    sse_thread.start()

    refresh_health(url)
    # SSE is live-only — seed whatever the server currently sees as active
    # so jobs that started before we connected don't render as "idle". SSE
    # events that arrive after this point still win on jobs they touch
    # because `bootstrap_active_jobs` only fills gaps.
    bootstrap_active_jobs(url)
    last_health = time.time()

    try:
        while not stop_event.is_set():
            if time.time() - last_health > HEALTH_REFRESH_SECONDS:
                refresh_health(url)
                last_health = time.time()
            sys.stdout.write(render(url))
            sys.stdout.flush()
            stop_event.wait(args.interval)
    finally:
        print(f"\n{DIM}Dashboard stopped.{RESET}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
