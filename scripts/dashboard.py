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
import atexit
import json
import os
import select
import signal
import sys
import termios
import threading
import time
import tty
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
RECENT_SKIPPED_MAX = 50  # ring buffer for the `s` panel; server caps at 100
SKIPPED_PANEL_VISIBLE = 20  # rows shown when `s` is pressed
REPEAT_CONTEXT_WINDOW_SECONDS = 300  # 5-minute rolling window
REPEAT_CONTEXT_THRESHOLD = 5  # ≥N hits on same contextId in window → spike
STREAM_STALL_SECONDS = 60  # silent-SSE watchdog window — see staleness_watchdog

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
        # about). Counted separately from duplicates so the header can
        # render `Skipped: <total> (no-match: N, dup: M)` and a human can
        # tell legitimate filter actions from re-delivery storms.
        self.routing_skipped_count: int = 0
        self.routing_skipped_last_time: int = 0
        self.duplicate_skipped_count: int = 0
        self.duplicate_skipped_last_time: int = 0
        # Recent rejections with full per-event context, for the `s` panel.
        # Newest first. Cap mirrors the server's REST cap so SSE + bootstrap
        # don't drift past what the dashboard can show.
        self.recent_skipped: deque[dict[str, Any]] = deque(maxlen=RECENT_SKIPPED_MAX)
        # Per-contextId no-match timestamps, for the spike heuristic. Keys
        # are evicted when their deque empties — a contextId that rejects
        # once and never again would otherwise leave a 1-element deque
        # forever.
        self.repeat_context_window: dict[str, deque[float]] = {}
        # Toggled by the `s` keybind; render() swaps panels accordingly.
        self.show_skipped_panel: bool = False
        # wall-clock of the last byte off the SSE wire — includes keepalives.
        # Tells us TCP is healthy. Used only for the connection LED, NOT for
        # staleness detection (a chatty keepalive can mask a frozen producer).
        self.last_event_at: float = 0.0
        # wall-clock of the last REAL event frame (i.e. `id:` line landed and
        # we dispatched it). Drives the staleness watchdog: when a job is
        # active but no real events have arrived within STREAM_STALL_SECONDS,
        # the dashboard re-bootstraps from /api/queue/snapshot rather than
        # silently freezing while the SSE channel chugs along on keepalives.
        # SPE-1976.
        self.last_real_event_at: float = 0.0
        # Highest event id we've successfully dispatched. Sent back as
        # Last-Event-ID on every SSE reconnect so the server replays only
        # what we missed. Updated synchronously from the SSE reader thread.
        self.last_event_id: int = 0
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


def _describe_bash(args: dict[str, Any]) -> str:
    command = args.get("command", "")
    if isinstance(command, str):
        return command.split("\n", 1)[0][:60]
    return ""


def _describe_file_tool(args: dict[str, Any]) -> str:
    path = args.get("file_path") or args.get("notebook_path", "")
    if isinstance(path, str) and path:
        return _shorten_path(path)
    return ""


def _describe_grep(args: dict[str, Any]) -> str:
    pattern = str(args.get("pattern", ""))
    scope = args.get("glob") or args.get("type") or args.get("path", "")
    return f"{pattern[:35]}{f' in {scope}' if scope else ''}"[:55]


def _describe_tool_search(args: dict[str, Any]) -> str:
    query = str(args.get("query", ""))
    if query.startswith("select:"):
        names = [n for n in query[len("select:") :].split(",") if n]
        if len(names) == 1:
            # Show the tool suffix after the last `__` — that's the
            # semantically meaningful part (getJiraIssue, createEvent).
            return f"load {names[0].rsplit('__', 1)[-1]}"
        return f"load {len(names)} tools"
    return query[:55]


def _describe_agent(args: dict[str, Any]) -> str:
    subagent = args.get("subagent_type", "agent")
    description = args.get("description", "")
    return f"{subagent}: {description}"[:55]


def _describe_todo_write(args: dict[str, Any]) -> str:
    todos = args.get("todos", [])
    return f"{len(todos)} todos" if isinstance(todos, list) else ""


def _describe_mcp(args: dict[str, Any]) -> str:
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


def describe_tool_call(tool: str, args: Any) -> str:
    """Render a short detail string for a tool call so `Read` shows WHAT was
    read. Falls back to empty if args are missing — the renderer will just
    show the tool name on its own."""
    if not isinstance(args, dict):
        return ""

    if tool == "Bash":
        return _describe_bash(args)
    if tool in _FILE_TOOLS:
        return _describe_file_tool(args)
    if tool == "Grep":
        return _describe_grep(args)
    if tool == "Glob":
        return str(args.get("pattern", ""))[:55]
    if tool == "ToolSearch":
        return _describe_tool_search(args)
    if tool == "Agent":
        return _describe_agent(args)
    if tool == "TodoWrite":
        return _describe_todo_write(args)
    if tool.startswith("mcp__"):
        return _describe_mcp(args)
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


def _handle_webhook_accepted(trace_id: str, payload: dict[str, Any]) -> None:
    STATE.trace_context[trace_id] = {
        "id": payload.get("contextId", "?"),
        "title": payload.get("contextTitle", "?"),
        "status": payload.get("contextStatus", "?"),
        "provider": payload.get("provider", "?"),
    }


def _handle_webhook_rejected(payload: dict[str, Any]) -> None:
    reason = payload.get("reason", "?")
    timestamp = payload.get("timestamp", 0)

    # Every rejection lands in the recent-skipped panel buffer with full
    # context so pressing `s` answers "what got dropped, and why?" without
    # log grep. The header counter only sums the routing reasons (no-match
    # + dup); signature failures stay visible in RECENT today and are
    # tracked separately via the server's getCounts() for completeness.
    STATE.recent_skipped.appendleft(
        {
            "timestamp": timestamp,
            "provider": payload.get("provider", "?"),
            "reason": reason,
            "contextId": payload.get("contextId", ""),
            "contextStatus": payload.get("contextStatus", ""),
            "contextTitle": payload.get("contextTitle", ""),
            "traceId": payload.get("traceId", ""),
        }
    )

    if reason == "no-routing-match":
        STATE.routing_skipped_count += 1
        STATE.routing_skipped_last_time = timestamp
        # Track repeat rejections on the same ticket — a real misconfig
        # signal vs the steady drip of expected fan-out.
        _record_repeat_context(payload.get("contextId", ""), now=time.time())
    elif reason == "duplicate":
        STATE.duplicate_skipped_count += 1
        STATE.duplicate_skipped_last_time = timestamp
    else:
        # Signature failures — keep them visible in RECENT (they're real
        # security signal, not just routing noise) instead of burying them.
        STATE.recent.appendleft(
            {
                "kind": "rejected",
                "time": timestamp,
                "provider": payload.get("provider", "?"),
                "reason": reason,
            }
        )


def _record_repeat_context(context_id: str, *, now: float) -> None:
    """Append a hit for `context_id` at `now`, ignoring unknown ids.

    `now` is injected so the heuristic tests stay deterministic. Empty or
    "?" ids are skipped — every rejection without an extractable context
    would otherwise stack under one bucket and trip the spike heuristic
    spuriously.
    """
    if not context_id or context_id == "?":
        return
    bucket = STATE.repeat_context_window.setdefault(context_id, deque())
    bucket.append(now)


def _evict_stale_repeat_context(now: float) -> None:
    """Pop entries older than the window from each bucket; drop empty keys.

    Called on every read so the dict can't grow unbounded with one-shot
    contexts that never return — otherwise a contextId rejected once would
    leave a 1-element deque in the dict for the lifetime of the dashboard.
    """
    cutoff = now - REPEAT_CONTEXT_WINDOW_SECONDS
    drop: list[str] = []
    for context_id, bucket in STATE.repeat_context_window.items():
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if not bucket:
            drop.append(context_id)
    for context_id in drop:
        STATE.repeat_context_window.pop(context_id, None)


def _repeat_context_active(now: float) -> bool:
    """True if any contextId has crossed the threshold within the window."""
    _evict_stale_repeat_context(now)
    return any(
        len(bucket) >= REPEAT_CONTEXT_THRESHOLD
        for bucket in STATE.repeat_context_window.values()
    )


def _handle_job_queued(job_id: str, trace_id: str, payload: dict[str, Any]) -> None:
    STATE.job_trace[job_id] = trace_id
    STATE.queued[job_id] = {
        "provider": payload.get("provider", "?"),
        "title": payload.get("contextTitle", "?"),
        "context_id": payload.get("contextId", "?"),
        "queued_at": payload.get("timestamp", 0),
    }


def _handle_job_requeued(job_id: str, trace_id: str, payload: dict[str, Any]) -> None:
    STATE.job_trace[job_id] = trace_id
    STATE.queued[job_id] = {
        "provider": payload.get("provider", "?"),
        "title": STATE.queued.get(job_id, {}).get("title", "?"),
        "context_id": STATE.queued.get(job_id, {}).get("context_id", "?"),
        "queued_at": payload.get("timestamp", 0),
        "attempt": payload.get("attempt", 1),
    }


def _handle_job_started(job_id: str, trace_id: str, payload: dict[str, Any]) -> None:
    STATE.job_trace[job_id] = trace_id
    STATE.queued.pop(job_id, None)
    STATE.active[job_id] = _new_active_entry(payload)


def _handle_assistant_text(job_id: str, payload: dict[str, Any]) -> None:
    if job_id not in STATE.active:
        return
    text = payload.get("text", "")
    STATE.active[job_id]["phase"] = "thinking"
    STATE.active[job_id]["latest"] = text[:120]
    STATE.active[job_id]["text_history"].appendleft(
        {"time": payload.get("timestamp", 0), "text": text}
    )
    STATE.active[job_id]["last_event_at"] = time.time()


def _handle_tool_call(job_id: str, payload: dict[str, Any]) -> None:
    if job_id not in STATE.active:
        return
    tool = payload.get("tool", "?")
    detail = describe_tool_call(tool, payload.get("args"))
    STATE.active[job_id]["tool"] = tool
    STATE.active[job_id]["phase"] = f"tool: {tool}"
    STATE.active[job_id]["tool_history"].appendleft(
        {"time": payload.get("timestamp", 0), "tool": tool, "detail": detail}
    )
    STATE.active[job_id]["last_event_at"] = time.time()


def _handle_runner_result(job_id: str, payload: dict[str, Any]) -> None:
    if job_id not in STATE.active:
        return
    STATE.active[job_id]["turns"] = payload.get("turns", 0)
    STATE.active[job_id]["cost"] = payload.get("costUsd", 0.0)
    STATE.active[job_id]["phase"] = "finishing"
    STATE.active[job_id]["last_event_at"] = time.time()


def _handle_job_completed(job_id: str, trace_id: str, payload: dict[str, Any]) -> None:
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


def _handle_job_failed(job_id: str, trace_id: str, payload: dict[str, Any]) -> None:
    # Always clear from active — a retry will arrive as a new jobId via
    # job.started, not as a continuation of this one. Previously we only
    # popped on `final` failures, which left non-final failures as
    # zombies in the active list forever.
    STATE.active.pop(job_id, None)
    ctx = STATE.trace_context.get(trace_id, {})
    if not payload.get("final"):
        # Non-final failures will be followed by a job.requeued event
        return
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


def handle_event(event_type: str, payload: dict[str, Any]) -> None:
    trace_id = payload.get("traceId", "")
    job_id = payload.get("jobId", "")

    with STATE.lock:
        STATE.last_event_at = time.time()

        if event_type == "webhook.accepted":
            _handle_webhook_accepted(trace_id, payload)
        elif event_type == "webhook.rejected":
            _handle_webhook_rejected(payload)
        elif event_type == "job.queued":
            _handle_job_queued(job_id, trace_id, payload)
        elif event_type == "job.requeued":
            _handle_job_requeued(job_id, trace_id, payload)
        elif event_type == "job.started":
            _handle_job_started(job_id, trace_id, payload)
        elif event_type == "runner.assistant_text":
            _handle_assistant_text(job_id, payload)
        elif event_type == "runner.tool_call":
            _handle_tool_call(job_id, payload)
        elif event_type == "runner.result":
            _handle_runner_result(job_id, payload)
        elif event_type == "job.completed":
            _handle_job_completed(job_id, trace_id, payload)
        elif event_type == "job.failed":
            _handle_job_failed(job_id, trace_id, payload)


# ── SSE reader ───────────────────────────────────────────────────────
def stream_events(url: str, stop_event: threading.Event) -> None:
    """Run the SSE reader in its own thread, auto-reconnecting on drop.

    On every (re)connect we forward `STATE.last_event_id` as `Last-Event-ID`
    so the server replays only the events we missed. The first connect of a
    process sends id=0, which the server treats as "everything in the buffer
    after id=1" — combined with the `/api/queue/snapshot` bootstrap, that
    closes the silent-restart hole. SPE-1976.
    """
    backoff = 1.0
    while not stop_event.is_set():
        try:
            with STATE.lock:
                resume_from = STATE.last_event_id

            request = urllib_request.Request(
                f"{url}/api/events",
                headers={"Accept": "text/event-stream", "Cache-Control": "no-cache"},
            )
            if resume_from > 0:
                request.add_header("Last-Event-ID", str(resume_from))
            token = os.environ.get("CLAWNDOM_TOKEN")
            if token:
                request.add_header("Authorization", f"Bearer {token}")

            with urllib_request.urlopen(request, timeout=None) as stream:
                with STATE.lock:
                    STATE.sse_connected = True
                    STATE.sse_error = ""
                backoff = 1.0
                parse_sse_stream(stream, stop_event, url)

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


def _dispatch_sse_frame(
    event: str, data: list[str], frame_id: int, url: str
) -> None:
    if event == "gap":
        # The server told us our requested Last-Event-ID is older than its
        # ring buffer, so the replay slice is incomplete. Re-bootstrap from
        # the snapshot endpoint to recover authoritative state. SPE-1976.
        bootstrap_from_snapshot(url)
        return
    if not data:
        return
    payload_text = "\n".join(data)
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        payload = {}
    handle_event(event, payload)
    with STATE.lock:
        STATE.last_real_event_at = time.time()
        if frame_id > STATE.last_event_id:
            STATE.last_event_id = frame_id


def parse_sse_stream(stream: Any, stop_event: threading.Event, url: str) -> None:
    """Parse SSE framing: `id: 42\\nevent: foo\\ndata: {...}\\n\\n`.

    `id:` lines are tracked so that on reconnect we can send Last-Event-ID
    and pick up exactly where we left off — that's what closes the
    silent-drop window in SPE-1976.
    """
    current_event = "message"
    current_data: list[str] = []
    current_id = 0

    for raw in stream:
        if stop_event.is_set():
            return
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")

        if line == "":
            _dispatch_sse_frame(current_event, current_data, current_id, url)
            current_event = "message"
            current_data = []
            current_id = 0
            continue

        if line.startswith(":"):
            # Comment frame (keepalive). Updates `last_event_at` (TCP is
            # alive) but NOT `last_real_event_at` — see staleness_watchdog.
            with STATE.lock:
                STATE.last_event_at = time.time()
            continue

        if line.startswith("id:"):
            try:
                current_id = int(line[len("id:") :].strip())
            except ValueError:
                current_id = 0
        elif line.startswith("event:"):
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


def bootstrap_skipped_webhooks(url: str) -> None:
    """Seed STATE.recent_skipped + counters from /api/webhooks/skipped/recent
    so a dashboard reconnecting mid-day doesn't reset to zeros. Same merge
    discipline as bootstrap_active_jobs: SSE that already updated state
    takes precedence — this only fills in pre-connect history."""
    try:
        with urllib_request.urlopen(
            f"{url}/api/webhooks/skipped/recent?limit={RECENT_SKIPPED_MAX}", timeout=3
        ) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return

    skipped = body.get("skipped", [])
    counts = body.get("counts", {})
    if not isinstance(skipped, list):
        return

    with STATE.lock:
        # Counts are cumulative on the server — only adopt them if our own
        # session hasn't started counting yet, otherwise we'd double up.
        if STATE.routing_skipped_count == 0 and STATE.duplicate_skipped_count == 0:
            STATE.routing_skipped_count = int(counts.get("noMatch", 0) or 0)
            STATE.duplicate_skipped_count = int(counts.get("duplicate", 0) or 0)
        if not STATE.recent_skipped:
            for entry in skipped:
                if not isinstance(entry, dict):
                    continue
                STATE.recent_skipped.append(
                    {
                        "timestamp": entry.get("timestamp", 0),
                        "provider": entry.get("provider", "?"),
                        "reason": entry.get("reason", "?"),
                        "contextId": entry.get("contextId", ""),
                        "contextStatus": entry.get("contextStatus", ""),
                        "contextTitle": entry.get("contextTitle", ""),
                        "traceId": entry.get("traceId", ""),
                    }
                )
                # Update last-seen timestamps from history so the header's
                # "last <time>" is correct on reconnect.
                ts = entry.get("timestamp", 0)
                reason = entry.get("reason", "")
                if reason == "no-routing-match" and ts > STATE.routing_skipped_last_time:
                    STATE.routing_skipped_last_time = ts
                elif reason == "duplicate" and ts > STATE.duplicate_skipped_last_time:
                    STATE.duplicate_skipped_last_time = ts


def _seed_active_from_snapshot(jobs: list[dict[str, Any]], now: float) -> None:
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


def _seed_recent_from_snapshot(items: list[dict[str, Any]]) -> None:
    # The server returns RecentCompletion[] newest-first. We appendleft into
    # STATE.recent (also newest-first), so we have to iterate the snapshot in
    # reverse to preserve order. Field names map server→dashboard:
    # `outcome` → `kind`, `completedAt` → `time`, `agentId` → `agent_id`.
    # Restarts don't restore `turns` / `cost` — those are live-only metrics
    # from runner.result and are gone with the previous process. The
    # renderer treats missing values as 0/$0.000.
    for entry in reversed(items):
        outcome = entry.get("outcome", "completed")
        if outcome not in {"completed", "failed", "rejected"}:
            continue
        STATE.recent.appendleft(
            {
                "kind": outcome,
                "time": entry.get("completedAt", 0),
                "job_id": entry.get("jobId", ""),
                "context": entry.get("context") or {},
                "duration_ms": entry.get("durationMs", 0),
                "turns": 0,
                "cost": 0.0,
                "agent_id": entry.get("agentId") or "?",
                "error": (entry.get("error") or "")[:60],
                "provider": entry.get("provider", "?"),
                "reason": entry.get("reason", "?"),
            }
        )


def bootstrap_from_snapshot(url: str) -> None:
    """Hydrate STATE from /api/queue/snapshot. Merges into existing state —
    SSE events that already landed take precedence over snapshot rows for
    the same jobId. Captures `latestEventId` so the next SSE connect resumes
    from the exact tip of the snapshot — no replay overlap, no missed
    events. SPE-1976.
    """
    try:
        with urllib_request.urlopen(f"{url}/api/queue/snapshot", timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return

    if not isinstance(body, dict):
        return

    active_jobs = body.get("active") or []
    recent = body.get("recentlyCompleted") or []
    latest_event_id = body.get("latestEventId", 0)

    now = time.time()
    with STATE.lock:
        if isinstance(active_jobs, list):
            _seed_active_from_snapshot(active_jobs, now)
        if isinstance(recent, list):
            _seed_recent_from_snapshot(recent)
        if isinstance(latest_event_id, int) and latest_event_id > STATE.last_event_id:
            STATE.last_event_id = latest_event_id


def staleness_watchdog(url: str) -> None:
    """Trip a re-bootstrap when SSE has gone silent on a job that should be
    chatty. Conditioned on `STATE.active` non-empty so we don't thrash the
    snapshot endpoint when the system is genuinely idle. The window is
    longer than the server's 15s keepalive, so normal quiet stretches
    (e.g. between tool calls during a long agent turn) don't trigger it.
    SPE-1976.
    """
    with STATE.lock:
        if not STATE.active:
            return
        if STATE.last_real_event_at == 0:
            return  # haven't seen any real event yet — nothing to compare
        elapsed = time.time() - STATE.last_real_event_at
    if elapsed >= STREAM_STALL_SECONDS:
        bootstrap_from_snapshot(url)


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
    no_match_count: int,
    duplicate_count: int,
    skipped_last_time: int,
    repeat_spike: bool,
) -> list[str]:
    hc = health_color(health)
    sse_state = f"{GREEN}SSE{RESET}" if sse_connected else f"{RED}SSE down{RESET}"
    now_text = datetime.now().strftime("%H:%M:%S")
    skipped_suffix = ""
    total = no_match_count + duplicate_count
    if total > 0:
        last = format_time(skipped_last_time) if skipped_last_time else "—"
        # Yellow when the repeat-context heuristic triggers — same ticket,
        # ≥5 no-match rejections in 5 minutes, almost certainly a misconfig.
        # Otherwise dim, so the counter doesn't compete with active work.
        label_color = YELLOW if repeat_spike else DIM
        skipped_suffix = (
            f"   {label_color}Skipped: {total} (no-match: {no_match_count}, "
            f"dup: {duplicate_count}, last {last}){RESET}"
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


def _render_skipped_panel(skipped: list[dict[str, Any]]) -> list[str]:
    if not skipped:
        return [
            "",
            f"  {BOLD}SKIPPED{RESET} {DIM}(press s to return){RESET}",
            f"  {DIM}No skipped webhooks recorded yet.{RESET}",
        ]
    lines = [
        "",
        (
            f"  {BOLD}SKIPPED{RESET} "
            f"{DIM}(last {min(SKIPPED_PANEL_VISIBLE, len(skipped))}, press s to return){RESET}"
        ),
    ]
    for entry in skipped[:SKIPPED_PANEL_VISIBLE]:
        timestamp = format_time(entry.get("timestamp", 0))
        reason = entry.get("reason", "?")
        # Color the reason so no-match (expected filter) reads quieter than
        # signature failures (real security signal).
        if reason in ("invalid-signature", "missing-signature"):
            reason_color = RED
        elif reason == "duplicate":
            reason_color = CYAN
        else:
            reason_color = DIM
        provider = entry.get("provider", "?")
        ctx_id = entry.get("contextId") or "—"
        ctx_status = entry.get("contextStatus") or ""
        title = (entry.get("contextTitle") or "")[:40]
        status_suffix = f" [{ctx_status}]" if ctx_status else ""
        lines.append(
            f"     {DIM}{timestamp}{RESET}  {reason_color}{reason:<18}{RESET}"
            f"{DIM}{provider:<8}{RESET}{ctx_id:<14}{DIM}{status_suffix} {title}{RESET}"
        )
    return lines


def _render_active_job_header(
    ctx: dict[str, str], job: dict[str, Any]
) -> list[str]:
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
    return lines


def _render_tool_history(tool_history: list[dict[str, Any]]) -> list[str]:
    if not tool_history:
        return []
    lines = [f"     {DIM}tools:{RESET}"]
    for entry in tool_history:
        tool_name = entry["tool"]
        detail = entry.get("detail", "")
        timestamp = format_time(entry.get("time", 0))
        detail_text = f"  {detail}" if detail else ""
        lines.append(
            f"       {DIM}{timestamp}{RESET}  {MAGENTA}{tool_name:<16}{RESET}"
            f"{DIM}{detail_text[:56]}{RESET}"
        )
    return lines


def _render_text_history(text_history: list[dict[str, Any]]) -> list[str]:
    if not text_history:
        return []
    lines = [f"     {DIM}said:{RESET}"]
    for entry in text_history:
        text = (entry.get("text") or "").replace("\n", " ")
        timestamp = format_time(entry.get("time", 0))
        lines.append(f"       {DIM}{timestamp}  \u201c{text[:60]}\u2026\u201d{RESET}")
    return lines


def _render_active_job(
    job_id: str,
    job: dict[str, Any],
    job_trace: dict[str, str],
    trace_context: dict[str, dict[str, str]],
) -> list[str]:
    trace_id = job_trace.get(job_id, "")
    ctx = trace_context.get(trace_id, {"id": "?", "title": "?", "status": "?"})

    lines = _render_active_job_header(ctx, job)
    lines.extend(_render_tool_history(list(job.get("tool_history") or ())))
    lines.extend(_render_text_history(list(job.get("text_history") or ())))
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
    now = time.time()
    with STATE.lock:
        health = STATE.health
        active = list(STATE.active.items())
        queued = list(STATE.queued.items())
        recent = list(STATE.recent)
        trace_context = STATE.trace_context.copy()
        job_trace = STATE.job_trace.copy()
        ticket_history = {k: v.copy() for k, v in STATE.ticket_history.items()}
        no_match_count = STATE.routing_skipped_count
        duplicate_count = STATE.duplicate_skipped_count
        # Header's "last" is the most recent of the two routing reasons.
        skipped_last_time = max(
            STATE.routing_skipped_last_time, STATE.duplicate_skipped_last_time
        )
        recent_skipped = list(STATE.recent_skipped)
        show_skipped_panel = STATE.show_skipped_panel
        repeat_spike = _repeat_context_active(now)
        sse_connected = STATE.sse_connected
        sse_error = STATE.sse_error

    lines = _render_header(
        url=url,
        health=health,
        sse_connected=sse_connected,
        active_count=len(active),
        queued_count=len(queued),
        no_match_count=no_match_count,
        duplicate_count=duplicate_count,
        skipped_last_time=skipped_last_time,
        repeat_spike=repeat_spike,
    )

    if not sse_connected and sse_error:
        lines.append(f"  {RED}SSE reader error: {sse_error[:70]}{RESET}")

    if show_skipped_panel:
        # Drill-down view: only the SKIPPED panel + footer. Everything else
        # is suppressed so the operator sees what they came for.
        lines.extend(_render_skipped_panel(recent_skipped))
        lines.append("")
        lines.append(f"  {DIM}Press s to return.  Ctrl+C to exit.{RESET}")
        return CLEAR + "\n".join(lines) + "\n"

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
    lines.append(f"  {DIM}Press s for skipped panel.  Ctrl+C to exit.{RESET}")

    return CLEAR + "\n".join(lines) + "\n"


# ── Keyboard input ───────────────────────────────────────────────────
_TTY_ORIGINAL_MODE: list[Any] | None = None
_TTY_FD: int | None = None


def _setup_cbreak_terminal() -> bool:
    """Switch stdin to cbreak so single keypresses arrive without Enter.

    Returns True on success. Falls back gracefully when stdin isn't a TTY
    (e.g. piped input, --once mode) — the dashboard still renders, just
    without the `s` keybind.
    """
    global _TTY_ORIGINAL_MODE, _TTY_FD
    if not sys.stdin.isatty():
        return False
    try:
        _TTY_FD = sys.stdin.fileno()
        _TTY_ORIGINAL_MODE = termios.tcgetattr(_TTY_FD)
        tty.setcbreak(_TTY_FD)
        atexit.register(_restore_terminal)
        return True
    except (termios.error, OSError):
        return False


def _restore_terminal() -> None:
    if _TTY_FD is not None and _TTY_ORIGINAL_MODE is not None:
        try:
            termios.tcsetattr(_TTY_FD, termios.TCSADRAIN, _TTY_ORIGINAL_MODE)
        except (termios.error, OSError):
            pass


def _poll_key() -> str | None:
    """Non-blocking keypress read; returns the character or None."""
    if _TTY_FD is None:
        return None
    try:
        ready, _, _ = select.select([sys.stdin], [], [], 0)
    except (OSError, ValueError):
        return None
    if not ready:
        return None
    try:
        return sys.stdin.read(1)
    except (OSError, ValueError):
        return None


def _handle_keypress(key: str) -> None:
    if key == "s":
        with STATE.lock:
            STATE.show_skipped_panel = not STATE.show_skipped_panel


# ── Main loop ────────────────────────────────────────────────────────
def main() -> None:
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
        bootstrap_from_snapshot(url)
        bootstrap_skipped_webhooks(url)
        sys.stdout.write(render(url))
        sys.stdout.flush()
        return

    stop_event = threading.Event()

    def handle_sigint(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigint)

    sse_thread = threading.Thread(target=stream_events, args=(url, stop_event), daemon=True)
    sse_thread.start()

    refresh_health(url)
    # Seed active + recent + latestEventId from the snapshot endpoint before
    # the SSE reader even connects, so a dashboard restart never blanks the
    # operator's view. The captured event id is what the SSE thread sends
    # as Last-Event-ID on its first connect.
    bootstrap_from_snapshot(url)
    bootstrap_skipped_webhooks(url)
    last_health = time.time()

    keys_enabled = _setup_cbreak_terminal()

    try:
        while not stop_event.is_set():
            if time.time() - last_health > HEALTH_REFRESH_SECONDS:
                refresh_health(url)
                last_health = time.time()
            staleness_watchdog(url)
            if keys_enabled:
                key = _poll_key()
                if key is not None:
                    _handle_keypress(key)
            sys.stdout.write(render(url))
            sys.stdout.flush()
            stop_event.wait(args.interval)
    finally:
        _restore_terminal()
        print(f"\n{DIM}Dashboard stopped.{RESET}")


if __name__ == "__main__":
    main()
