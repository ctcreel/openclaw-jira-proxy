"""Sample module for tool-block rendering tests.

This module exposes two public callables and one private helper. The
introspector should pick up the publics and skip the private one.
"""

from __future__ import annotations


def post_message(channel: str, text: str) -> str:
    """Post ``text`` to ``channel`` and return the message ts."""
    return f"{channel}:{text}"


def fetch_thread(channel: str, ts: str, *, limit: int = 50) -> list[str]:
    """Fetch up to ``limit`` messages from a thread.

    Default limit matches Slack's free-tier window.
    """
    return [f"{channel}#{ts}#{i}" for i in range(limit)]


def _internal_helper() -> None:
    """Should never appear in rendered docs."""
    return None
