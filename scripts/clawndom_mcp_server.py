#!/usr/bin/env python3
"""Clawndom MCP server bridge for SPE-2078 route-side tools.

Spawned by ``claude`` CLI via ``--mcp-config`` per run. Exposes the
route's declared tools to the model via the Model Context Protocol's
stdio JSON-RPC transport. When the model calls a tool, this server loads
the helper module, invokes it with credentials passed via env, writes a
single audit record per call (NDJSON), and returns the result.

Configuration is passed as a single JSON file path argument. The config
contains the tool descriptors. Credentials are passed via the
``CLAWNDOM_TOOL_CREDS`` env var (JSON-encoded ``{tool_name: {requires_key:
value}}``); audit log path via ``CLAWNDOM_AUDIT_LOG``; agent_version via
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
import re
import subprocess
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
    raw = os.environ.get("CLAWNDOM_TOOL_CREDS", "{}")
    return json.loads(raw)


def _agent_version():
    return os.environ.get("CLAWNDOM_AGENT_VERSION", "sha256:unknown")


def _audit_path():
    return os.environ.get("CLAWNDOM_AUDIT_LOG", "/var/log/clawndom-winston/audit.log")


def _redact_credentials(value, secrets):
    """Exact-match redaction. Mirrors src/lib/audit/redact.ts."""
    secret_set = {s for s in secrets if s}
    return _redact_value(value, secret_set)


def _redact_value(value, secrets):
    if isinstance(value, str):
        return "<redacted>" if value in secrets else value
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
        # config["tools"]: list of {name, description, args, requires, kind, reference, directory}
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
            if desc["kind"] == "python":
                result = self._call_python(desc, arguments, creds)
            else:
                result = self._call_bash(desc, arguments, creds)
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

    def _call_python(self, desc, arguments, creds):
        module_path = f"{desc['reference']}.impl"
        module = importlib.import_module(module_path)
        return module.invoke(**arguments, **creds)

    def _call_bash(self, desc, arguments, creds):
        script_path = os.path.join(desc["directory"], "impl.sh")
        env = os.environ.copy()
        for arg_name, arg_value in arguments.items():
            env[f"ARG_{arg_name.upper()}"] = (
                arg_value if isinstance(arg_value, str) else json.dumps(arg_value)
            )
        for cred_name, cred_value in creds.items():
            env[cred_name.upper()] = cred_value
        result = subprocess.run(
            ["bash", script_path],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            tail = "\n".join(result.stderr.strip().split("\n")[-3:])
            raise RuntimeError(f"bash tool failed: {tail or f'exit {result.returncode}'}")
        stdout = result.stdout.strip()
        if not stdout:
            return None
        return json.loads(stdout)


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
