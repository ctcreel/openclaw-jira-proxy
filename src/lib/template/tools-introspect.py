#!/usr/bin/env python3
"""Introspect Python helper modules for the clawndom template tool renderer.

Stdin: JSON object ``{"modules": ["agency_tools.slack.post", ...]}``.
Stdout: JSON map keyed by module name. Each entry is either a successful
introspection ``{"ok": true, "doc": "...", "callables": [...]}`` or an
``{"ok": false, "error": "ImportError: ..."}`` so the Node-side renderer can
surface the offending dotted path verbatim.

Why a separate Python subprocess instead of TypeScript-side AST parsing:
docstrings, signatures, and re-exports are computed at runtime in CPython
(``functools.wraps`` decorators, dynamic ``__all__``, default argument
introspection). A TS-side walker would re-implement a non-trivial subset of
CPython and break the moment a helper uses anything fancier than a bare
``def``. Thirty lines of Python keep us correct.

Why ``inspect.getmembers`` filtered by ``inspect.isfunction``: top-level
helpers in ``agency_tools`` are plain ``def`` functions. Methods on classes,
generator functions, and async functions are out of scope until a real use
case arrives. Adding them later is additive — nothing here forecloses it.

Public callables are functions whose name does not start with ``_`` AND
which are defined in the module under inspection (``func.__module__ ==
module.__name__``). The latter filter excludes re-imports — e.g. ``post.py``
does ``from ._http import _req`` and we don't want ``_req`` showing up on
every module that imports it (it wouldn't because of the underscore prefix,
but the same would apply to a public re-import like ``from .errors import
SlackAPIError``).
"""

from __future__ import annotations

import importlib
import inspect
import json
import sys


def _format_signature(func) -> str:
    """Return ``name(arg1, arg2=default)`` form. Falls back to ``name(...)`` if
    inspect.signature can't introspect (rare — C-extension bound methods)."""
    try:
        return f"{func.__name__}{inspect.signature(func)}"
    except (TypeError, ValueError):
        return f"{func.__name__}(...)"


def _introspect_module(dotted_path: str) -> dict:
    try:
        module = importlib.import_module(dotted_path)
    except Exception as exc:  # ImportError, but also ModuleNotFoundError, etc.
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    callables = []
    for name, member in inspect.getmembers(module, inspect.isfunction):
        if name.startswith("_"):
            continue
        if getattr(member, "__module__", None) != module.__name__:
            # Skip re-imports — they're documented in their original module.
            continue
        callables.append(
            {
                "name": name,
                "signature": _format_signature(member),
                "doc": inspect.getdoc(member) or "",
            }
        )

    # Stable order (dotted-path users will diff this output): alphabetical by
    # name. ``inspect.getmembers`` already returns sorted, but be explicit so
    # a future Python version's ordering change can't bust the prompt cache.
    callables.sort(key=lambda c: c["name"])

    return {
        "ok": True,
        "doc": inspect.getdoc(module) or "",
        "callables": callables,
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"stdin is not valid JSON: {exc}"}, sys.stdout)
        return 2

    modules = request.get("modules", [])
    if not isinstance(modules, list):
        json.dump({"error": "request.modules must be a list of dotted paths"}, sys.stdout)
        return 2

    result = {dotted: _introspect_module(dotted) for dotted in modules}
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
