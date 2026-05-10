"""Helper module that documents requires_env-style argument shape.

Used in tests to verify the rendered tool block emits the
``bot_token=os.environ['SLACK_BOT_TOKEN']`` invocation idiom for helpers
declaring a single ``requires_env`` entry.
"""

from __future__ import annotations


def post(*, bot_token: str, channel: str, text: str) -> dict:
    """Post a message, authenticating with ``bot_token``."""
    return {"ok": True, "channel": channel, "text": text, "token_len": len(bot_token)}
