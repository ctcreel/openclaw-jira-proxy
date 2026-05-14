#!/usr/bin/env python3
"""Clawndom MCP server bridge for SPE-2078 route-side tools.

Spawned by ``claude`` CLI via ``--mcp-config`` per run. Exposes the
route's declared Python tools to the model via the Model Context
Protocol's stdio JSON-RPC transport. When the model calls a tool, this
server loads the helper module, invokes it with credentials passed via
env, writes a single audit record per call (NDJSON), and returns the
result.

Configuration is passed as a single JSON file path argument. The config
contains the tool descriptors. Credentials are passed via a mode-600
file at the path in ``CLAWNDOM_TOOL_CREDS_FILE`` (JSON-encoded
``{tool_name: {canonical_name: value}}``); the file is read once and
unlinked. Audit log path via ``CLAWNDOM_AUDIT_LOG``; agent_version via
``CLAWNDOM_AGENT_VERSION``; agent + route IDs via ``CLAWNDOM_AGENT_ID``
and ``CLAWNDOM_ROUTE_ID``; request id via ``CLAWNDOM_REQUEST_ID``.

The MCP protocol surface is intentionally minimal:
  - initialize
  - tools/list
  - tools/call
  - notifications/initialized (no-op)

See: https://modelcontextprotocol.io/specification
"""

import datetime
import importlib
import json
import os
import sys
import time


def _log(message):
    """Write to stderr so the parent claude-cli captures it but it doesn't pollute the stdio JSON-RPC."""
    sys.stderr.write(f"[clawndom-mcp] {message}\n")
    sys.stderr.flush()


def _load_config(path):
    with open(path) as f:
        return json.load(f)


def _load_credentials():
    """Read the per-run credentials file once, then unlink it.

    Credentials arrive via a mode-600 file path passed in
    CLAWNDOM_TOOL_CREDS_FILE rather than as the env value itself. The
    Linux kernel snapshots envp at execve() time and exposes it via
    /proc/<pid>/environ for the lifetime of the process — os.environ.pop
    cannot scrub that snapshot. Passing only the path through env keeps
    the literal credential value out of /proc entirely. We unlink the
    file immediately after read so a later /proc/<pid>/cwd or
    open-file-table sweep yields nothing either.
    """
    path = os.environ.pop("CLAWNDOM_TOOL_CREDS_FILE", "")
    if not path:
        return {}
    try:
        with open(path) as f:
            raw = f.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return json.loads(raw) if raw else {}


def _agent_version():
    return os.environ.get("CLAWNDOM_AGENT_VERSION", "sha256:unknown")


def _audit_path():
    return os.environ.get("CLAWNDOM_AUDIT_LOG", "/var/log/clawndom-winston/audit.log")


def _redact_credentials(value, secrets):
    """Substring redaction. Mirrors src/lib/audit/redact.ts.

    Exact-match is insufficient — an in-process impl can embed the
    credential inside a larger string (an env dump, a /proc snapshot, a
    stack trace) and exact-match would let that through. Replace every
    occurrence as a substring instead. Longest secrets are replaced first
    so a short secret that happens to be a prefix of a long one doesn't
    half-redact and leak the tail.
    """
    ordered = sorted({s for s in secrets if s}, key=len, reverse=True)
    return _redact_value(value, ordered)


def _redact_value(value, secrets):
    if isinstance(value, str):
        out = value
        for secret in secrets:
            if secret in out:
                out = out.replace(secret, "<redacted>")
        return out
    if isinstance(value, list):
        return [_redact_value(v, secrets) for v in value]
    if isinstance(value, dict):
        return {k: _redact_value(v, secrets) for k, v in value.items()}
    return value


def _write_audit_record(record):
    path = _audit_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(record) + "\n")


def _now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


class ToolRegistry:
    def __init__(self, config):
        # config["tools"]: list of {name, description, args, secrets, reference, directory}.
        # `secrets` is a list of {canonical, aliases}; per-tool credential maps
        # (keyed by canonical name) arrive via the file at
        # CLAWNDOM_TOOL_CREDS_FILE, so the server itself never resolves
        # aliases — load-for-run did that.
        self.descriptors = {t["name"]: t for t in config.get("tools", [])}
        self.credentials = _load_credentials()
        self.agent_id = os.environ.get("CLAWNDOM_AGENT_ID", "unknown")
        self.route_id = os.environ.get("CLAWNDOM_ROUTE_ID", "unknown")
        self.request_id = os.environ.get("CLAWNDOM_REQUEST_ID", "unknown")
        self.correlation_id = os.environ.get("CLAWNDOM_CORRELATION_ID") or self.request_id

    def list_tools(self):
        out = []
        for desc in self.descriptors.values():
            properties = {}
            required = []
            for arg_name, arg_spec in desc.get("args", {}).items():
                properties[arg_name] = {
                    "type": arg_spec["type"],
                    "description": arg_spec.get("description", ""),
                }
                if not arg_spec.get("optional"):
                    required.append(arg_name)
            out.append(
                {
                    "name": desc["name"],
                    "description": desc["description"],
                    "inputSchema": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                    },
                }
            )
        return out

    def call_tool(self, name, arguments):
        desc = self.descriptors.get(name)
        if desc is None:
            raise ValueError(f"Unknown tool: {name}")
        creds = self.credentials.get(name, {})
        started = time.time()
        try:
            module_path = f"{desc['reference']}.impl"
            module = importlib.import_module(module_path)
            result = module.invoke(**arguments, **creds)
            error_summary = None
        except Exception as exc:
            error_summary = f"{type(exc).__name__}: {exc}".split("\n")[0]
            result = {"error": error_summary}
        latency_ms = int((time.time() - started) * 1000)

        secret_values = list(creds.values())
        redacted_args = _redact_credentials(arguments, secret_values)
        redacted_result = (
            _redact_credentials(result, secret_values) if error_summary is None else None
        )
        record = {
            "timestamp": _now_iso(),
            "agent_id": self.agent_id,
            "route_id": self.route_id,
            "tool_name": name,
            "args": redacted_args,
            "result_summary": redacted_result,
            "error_summary": error_summary,
            "latency_ms": latency_ms,
            "request_id": self.request_id,
            "correlation_id": self.correlation_id,
            "agent_version": _agent_version(),
        }
        try:
            _write_audit_record(record)
        except Exception as exc:
            _log(f"Failed to write audit record: {exc}")
        return result, error_summary is not None


def _respond(message_id, result=None, error=None):
    response = {"jsonrpc": "2.0", "id": message_id}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def _handle_request(registry, message):
    method = message.get("method")
    message_id = message.get("id")
    if method == "initialize":
        _respond(
            message_id,
            result={
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "clawndom-tools", "version": "1.0.0"},
            },
        )
    elif method == "notifications/initialized":
        pass  # no response for notifications
    elif method == "tools/list":
        _respond(message_id, result={"tools": registry.list_tools()})
    elif method == "tools/call":
        params = message.get("params", {})
        name = params.get("name", "")
        arguments = params.get("arguments", {})
        try:
            content, is_error = registry.call_tool(name, arguments)
            text = json.dumps(content) if not isinstance(content, str) else content
            _respond(
                message_id,
                result={
                    "content": [{"type": "text", "text": text}],
                    "isError": is_error,
                },
            )
        except Exception as exc:
            _respond(message_id, error={"code": -32603, "message": str(exc)})
    else:
        if message_id is not None:
            _respond(message_id, error={"code": -32601, "message": f"Method not found: {method}"})


def main():
    if len(sys.argv) < 2:
        _log("usage: clawndom_mcp_server.py <tool-config.json>")
        sys.exit(2)
    config = _load_config(sys.argv[1])
    registry = ToolRegistry(config)
    _log(f"Started with {len(registry.descriptors)} tools")
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            _log(f"Bad JSON-RPC frame: {exc}")
            continue
        try:
            _handle_request(registry, message)
        except Exception as exc:
            _log(f"Handler error: {exc}")
            if message.get("id") is not None:
                _respond(message["id"], error={"code": -32603, "message": str(exc)})


if __name__ == "__main__":
    main()
