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
        # jobId → active job dict
        self.active: dict[str, dict[str, Any]] = {}
        # recent outcomes, newest first
        self.recent: deque[dict[str, Any]] = deque(maxlen=RECENT_MAX)
        # wall-clock of last SSE event received
        self.last_event_at: float = 0.0
        # Whether the SSE reader is connected
        self.sse_connected: bool = False
        self.sse_error: str = ""


STATE = State()


# ── Event handlers ───────────────────────────────────────────────────
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
            STATE.recent.appendleft(
                {
                    "kind": "rejected",
                    "time": payload.get("timestamp", 0),
                    "provider": payload.get("provider", "?"),
                    "reason": payload.get("reason", "?"),
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
            # Track in queued again so display shows the retry
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
            STATE.active[job_id] = {
                "started_at": payload.get("timestamp", 0),
                "agent_id": payload.get("agentId", "?"),
                "template": payload.get("template"),
                "runner": payload.get("runner", "?"),
                "model": payload.get("model"),
                "provider": payload.get("provider", "?"),
                "phase": "starting",
                "tool": "",
                "latest": "",
                "last_event_at": time.time(),
                "turns": 0,
                "cost": 0.0,
            }

        elif event_type == "runner.assistant_text":
            if job_id in STATE.active:
                STATE.active[job_id]["phase"] = "thinking"
                STATE.active[job_id]["latest"] = payload.get("text", "")[:120]
                STATE.active[job_id]["last_event_at"] = time.time()

        elif event_type == "runner.tool_call":
            if job_id in STATE.active:
                tool = payload.get("tool", "?")
                STATE.active[job_id]["tool"] = tool
                STATE.active[job_id]["phase"] = f"tool: {tool}"
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
            STATE.recent.appendleft(
                {
                    "kind": "completed",
                    "time": payload.get("timestamp", 0),
                    "job_id": job_id,
                    "context": ctx,
                    "duration_ms": payload.get("durationMs", 0),
                    "turns": state.get("turns", 0) if state else 0,
                    "cost": state.get("cost", 0.0) if state else 0.0,
                    "agent_id": state.get("agent_id", "?") if state else "?",
                }
            )

        elif event_type == "job.failed":
            # Always clear from active — a retry will arrive as a new jobId via
            # job.started, not as a continuation of this one. Previously we only
            # popped on `final` failures, which left non-final failures as
            # zombies in the active list forever.
            STATE.active.pop(job_id, None)
            ctx = STATE.trace_context.get(trace_id, {})
            if payload.get("final"):
                STATE.recent.appendleft(
                    {
                        "kind": "failed",
                        "time": payload.get("timestamp", 0),
                        "job_id": job_id,
                        "context": ctx,
                        "error": payload.get("error", "")[:60],
                        "attempt": payload.get("attempt", 0),
                    }
                )


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


def render(url: str) -> str:
    with STATE.lock:
        health = STATE.health
        active = list(STATE.active.items())
        queued = list(STATE.queued.items())
        recent = list(STATE.recent)
        trace_context = STATE.trace_context.copy()
        job_trace = STATE.job_trace.copy()
        sse_connected = STATE.sse_connected
        sse_error = STATE.sse_error

    lines: list[str] = []
    now_text = datetime.now().strftime("%H:%M:%S")
    hc = health_color(health)
    sse_state = f"{GREEN}SSE{RESET}" if sse_connected else f"{RED}SSE down{RESET}"

    lines.append(f"{BOLD}{'═' * 80}{RESET}")
    lines.append(
        f"{BOLD}  CLAWNDOM{RESET}   {hc}{health}{RESET}   {sse_state}   "
        f"Active: {CYAN}{len(active)}{RESET}   "
        f"Queued: {YELLOW}{len(queued)}{RESET}   "
        f"{DIM}{url}   {now_text}{RESET}"
    )
    lines.append(f"{BOLD}{'═' * 80}{RESET}")

    if not sse_connected and sse_error:
        lines.append(f"  {RED}SSE reader error: {sse_error[:70]}{RESET}")

    # ── ACTIVE ──
    lines.append("")
    if active:
        for job_id, job in active:
            trace_id = job_trace.get(job_id, "")
            ctx = trace_context.get(trace_id, {"id": "?", "title": "?", "status": "?"})
            elapsed_seconds = (time.time() * 1000 - job["started_at"]) / 1000
            elapsed_text = (
                f"{int(elapsed_seconds // 60)}m {int(elapsed_seconds % 60)}s"
                if elapsed_seconds > 60
                else f"{int(elapsed_seconds)}s"
            )
            is_stale = (time.time() - job["last_event_at"]) > ACTIVE_STALE_SECONDS
            phase = job["phase"]
            phase_color = YELLOW if is_stale else CYAN
            model = job.get("model")
            model_suffix = f" {DIM}[{model}]{RESET}" if model else ""
            stale_marker = f" {DIM}(no runner events for {ACTIVE_STALE_SECONDS}s){RESET}" if is_stale else ""

            lines.append(
                f"  {GREEN}▶{RESET}  {BOLD}{ctx['id']:<14}{RESET}"
                f"[{ctx.get('status', '?')}]  → {job['agent_id']}{model_suffix}  "
                f"{phase_color}{phase}{RESET}  {DIM}({elapsed_text}){RESET}{stale_marker}"
            )
            title = ctx.get("title") or "?"
            if title != "?":
                lines.append(f"     {DIM}{title[:72]}{RESET}")
            latest = job.get("latest", "")
            if latest:
                lines.append(f"     {DIM}{latest[:72]}{RESET}")
    else:
        lines.append(f"  {DIM}No active jobs — idle{RESET}")

    # ── QUEUED ──
    if queued:
        lines.append("")
        lines.append(f"  {BOLD}QUEUED{RESET} {DIM}({len(queued)} waiting){RESET}")
        for job_id, job in queued[:8]:
            attempt_suffix = f" {DIM}retry {job['attempt']}{RESET}" if job.get("attempt") else ""
            lines.append(
                f"     {job['context_id']:<14} {DIM}{job['provider']}{RESET}  "
                f"{(job.get('title') or '?')[:50]}{attempt_suffix}"
            )

    # ── RECENT ──
    if recent:
        lines.append("")
        lines.append(f"  {BOLD}RECENT{RESET}")
        for item in recent:
            kind = item["kind"]
            t = format_time(item.get("time", 0))
            if kind == "completed":
                icon = f"{GREEN}✓{RESET}"
                ctx = item.get("context", {})
                duration_seconds = item.get("duration_ms", 0) / 1000
                detail = (
                    f"{duration_seconds:.1f}s  {item.get('turns', 0)} turns  "
                    f"${item.get('cost', 0.0):.3f}"
                )
                cid = ctx.get("id", "?")
                title = (ctx.get("title") or "?")[:40]
                lines.append(f"  {icon}  {t}  {cid:<14} {title:<42} {DIM}{detail}{RESET}")
            elif kind == "failed":
                icon = f"{RED}✗{RESET}"
                ctx = item.get("context", {})
                cid = ctx.get("id", "?")
                title = (ctx.get("title") or "?")[:40]
                error = item.get("error", "")
                lines.append(
                    f"  {icon}  {t}  {cid:<14} {title:<42} {RED}{error[:30]}{RESET}"
                )
            elif kind == "rejected":
                icon = f"{DIM}–{RESET}"
                reason = item.get("reason", "?")
                provider = item.get("provider", "?")
                lines.append(
                    f"  {icon}  {t}  {DIM}{provider:<14} {reason}{RESET}"
                )

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
