"""
Tests for scripts/dashboard.py — the pure-Python event handlers and the
per-contextId repeat-rejection heuristic introduced for SPE-1978.

stdlib `unittest` only — no pytest, no project Python deps. Run with:
    python3 -m unittest tests.scripts.test_dashboard
from the repo root, or just `python3 tests/scripts/test_dashboard.py`.

The tty / `s` keypress plumbing is excluded — terminal-mode interactions
require a real TTY and are covered by the manual smoke test.
"""
from __future__ import annotations

import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import dashboard  # noqa: E402  -- module path injection above is required first


def _reset_state() -> None:
    """Reset the global STATE between tests so handlers see a clean slate."""
    dashboard.STATE.routing_skipped_count = 0
    dashboard.STATE.routing_skipped_last_time = 0
    dashboard.STATE.duplicate_skipped_count = 0
    dashboard.STATE.duplicate_skipped_last_time = 0
    dashboard.STATE.recent.clear()
    dashboard.STATE.recent_skipped.clear()
    dashboard.STATE.repeat_context_window.clear()


class HandleWebhookRejectedTests(unittest.TestCase):
    """The handler partitions rejection reasons into the right counter and
    surfaces context-rich entries for the `s` panel."""

    def setUp(self) -> None:
        _reset_state()

    def test_no_routing_match_increments_routing_counter_only(self) -> None:
        dashboard._handle_webhook_rejected(
            {
                "reason": "no-routing-match",
                "timestamp": 100,
                "provider": "jira",
                "contextId": "SPE-101",
                "contextStatus": "Backlog",
                "contextTitle": "Comment fan-out",
            }
        )
        self.assertEqual(dashboard.STATE.routing_skipped_count, 1)
        self.assertEqual(dashboard.STATE.routing_skipped_last_time, 100)
        self.assertEqual(dashboard.STATE.duplicate_skipped_count, 0)
        # Did NOT spill into RECENT (RECENT is reserved for completed/failed/sigfail).
        self.assertEqual(len(dashboard.STATE.recent), 0)
        # DID land in the recent-skipped panel buffer with full context.
        self.assertEqual(len(dashboard.STATE.recent_skipped), 1)
        entry = dashboard.STATE.recent_skipped[0]
        self.assertEqual(entry["reason"], "no-routing-match")
        self.assertEqual(entry["contextId"], "SPE-101")
        self.assertEqual(entry["contextStatus"], "Backlog")

    def test_duplicate_increments_duplicate_counter_only(self) -> None:
        dashboard._handle_webhook_rejected(
            {
                "reason": "duplicate",
                "timestamp": 200,
                "provider": "jira",
                "contextId": "SPE-202",
                "contextStatus": "Ready for Development",
                "contextTitle": "Replay",
            }
        )
        self.assertEqual(dashboard.STATE.duplicate_skipped_count, 1)
        self.assertEqual(dashboard.STATE.duplicate_skipped_last_time, 200)
        self.assertEqual(dashboard.STATE.routing_skipped_count, 0)
        self.assertEqual(len(dashboard.STATE.recent), 0)
        self.assertEqual(len(dashboard.STATE.recent_skipped), 1)
        self.assertEqual(dashboard.STATE.recent_skipped[0]["reason"], "duplicate")

    def test_signature_failures_still_flow_to_recent(self) -> None:
        dashboard._handle_webhook_rejected(
            {
                "reason": "invalid-signature",
                "timestamp": 300,
                "provider": "github",
            }
        )
        self.assertEqual(dashboard.STATE.routing_skipped_count, 0)
        self.assertEqual(dashboard.STATE.duplicate_skipped_count, 0)
        # Sig failures stay in RECENT (visible, not buried) and ALSO appear
        # in the skipped panel for completeness.
        self.assertEqual(len(dashboard.STATE.recent), 1)
        self.assertEqual(dashboard.STATE.recent[0]["kind"], "rejected")
        self.assertEqual(dashboard.STATE.recent[0]["reason"], "invalid-signature")
        self.assertEqual(len(dashboard.STATE.recent_skipped), 1)
        self.assertEqual(
            dashboard.STATE.recent_skipped[0]["reason"], "invalid-signature"
        )


class RepeatContextHeuristicTests(unittest.TestCase):
    """5-minute rolling window: ≥5 no-match rejections on the same contextId
    → counter goes yellow. Stale entries get evicted; empty deques get
    pruned to prevent slow leaks (Scarlett's nice-to-have)."""

    def setUp(self) -> None:
        _reset_state()

    def test_below_threshold_does_not_trigger(self) -> None:
        for i in range(4):
            dashboard._record_repeat_context("SPE-1", now=1000.0 + i)
        self.assertFalse(dashboard._repeat_context_active(now=1004.0))

    def test_threshold_crosses_within_window_triggers(self) -> None:
        for i in range(5):
            dashboard._record_repeat_context("SPE-1", now=1000.0 + i)
        self.assertTrue(dashboard._repeat_context_active(now=1004.0))

    def test_window_decays_after_five_minutes(self) -> None:
        for i in range(5):
            dashboard._record_repeat_context("SPE-1", now=1000.0 + i)
        self.assertTrue(dashboard._repeat_context_active(now=1004.0))
        # 6 minutes after the last hit, the window has decayed past every entry.
        self.assertFalse(dashboard._repeat_context_active(now=1004.0 + 360))

    def test_different_context_ids_do_not_combine(self) -> None:
        for i in range(3):
            dashboard._record_repeat_context("SPE-1", now=1000.0 + i)
        for i in range(3):
            dashboard._record_repeat_context("SPE-2", now=1000.0 + i)
        # 3 + 3 across two contexts is not a spike on either.
        self.assertFalse(dashboard._repeat_context_active(now=1003.0))

    def test_unknown_context_id_is_ignored(self) -> None:
        # contextId missing or "?" should not register — every webhook with
        # no extractable context would otherwise stack up under one key.
        dashboard._record_repeat_context("?", now=1000.0)
        dashboard._record_repeat_context("", now=1000.0)
        self.assertNotIn("?", dashboard.STATE.repeat_context_window)
        self.assertNotIn("", dashboard.STATE.repeat_context_window)

    def test_empty_deque_keys_are_pruned(self) -> None:
        # Hit once at t=0, then evaluate at t=400 — the deque trims to empty
        # and the key should be dropped, not left as a 0-length deque forever.
        dashboard._record_repeat_context("SPE-stale", now=0.0)
        self.assertIn("SPE-stale", dashboard.STATE.repeat_context_window)
        # Calling _repeat_context_active triggers eviction.
        dashboard._repeat_context_active(now=400.0)
        self.assertNotIn("SPE-stale", dashboard.STATE.repeat_context_window)


class HandlerThroughDispatchTests(unittest.TestCase):
    """End-to-end check: dashboard.handle_event('webhook.rejected', ...)
    is the path SSE actually exercises. Confirm the partitioning logic
    survives that wrapping."""

    def setUp(self) -> None:
        _reset_state()

    def test_dispatch_routes_no_match(self) -> None:
        dashboard.handle_event(
            "webhook.rejected",
            {
                "reason": "no-routing-match",
                "timestamp": 1,
                "provider": "jira",
                "contextId": "SPE-9",
                "contextStatus": "Backlog",
                "contextTitle": "x",
            },
        )
        self.assertEqual(dashboard.STATE.routing_skipped_count, 1)
        self.assertEqual(dashboard.STATE.duplicate_skipped_count, 0)


if __name__ == "__main__":
    unittest.main()
