## ADDED Requirements

### Requirement: Route-Side Tool Declaration

Routing rules in `clawndom.yaml` MAY declare a `tools:` list. Each entry MUST use the key `module.python:` with a dotted Python import-path reference. Schema is extensible to additional `module.<lang>:` keys (e.g. `module.rust:`) by registering a new executor variant. The value MUST be a dotted reference whose segments are valid Python identifiers (letters, digits, underscores; no hyphens).

#### Scenario: Unknown Key is Rejected
- **GIVEN** A tool entry containing a key other than `module.python:` (e.g. `module.bash:` or `module.rust:`)
- **WHEN** Clawndom loads the agent config at boot
- **THEN** Boot MUST fail with a schema-validation error naming the offending entry

#### Scenario: Empty Entry is Rejected
- **GIVEN** A tool entry containing no recognized key
- **WHEN** Clawndom loads the agent config at boot
- **THEN** Boot MUST fail with a schema-validation error

#### Scenario: Python Reference With Hyphen is Rejected
- **GIVEN** A tool entry `module.python: agency_tools.slack-post`
- **WHEN** Clawndom loads the agent config at boot
- **THEN** Boot MUST fail with a clear message indicating Python references may not contain hyphens

#### Scenario: Routes Without Tools Remain Functional
- **GIVEN** A routing rule that does not declare `tools:`
- **WHEN** Clawndom processes an event matching that rule
- **THEN** The runner MUST behave as it did before this change; no tool-use loop is entered

### Requirement: Tool Directory Layout

Each declared tool MUST resolve to a directory containing a `tool.yaml` file and an `impl.py` file. Dotted reference segments are interpreted as directory separators; the final directory is the tool. Intermediate directories (categories) are OPTIONAL — a tool may sit at any depth as long as its directory contains `tool.yaml`.

#### Scenario: Tool With Category Resolves Correctly
- **GIVEN** A route declares `module.python: agency_tools.slack.post`
- **WHEN** Clawndom resolves the tool at boot
- **THEN** The resolver MUST locate the directory `<agency_tools-package-path>/slack/post/` and the resolution MUST succeed only if both `tool.yaml` and `impl.py` exist there

#### Scenario: Tool Without Category Resolves Correctly
- **GIVEN** A route declares `module.python: winston_agent.standalone_thing`
- **WHEN** Clawndom resolves the tool at boot
- **THEN** The resolver MUST locate the directory `<winston_agent-package-path>/standalone_thing/` and validate it contains `tool.yaml` and `impl.py`

#### Scenario: Missing tool.yaml Fails Boot
- **GIVEN** A declared tool whose resolved directory lacks `tool.yaml`
- **WHEN** Clawndom loads agent configs at boot
- **THEN** Boot MUST fail with a clear error naming the missing file and the offending tool reference

### Requirement: Tool Definition File Format

A `tool.yaml` MUST conform to the following structure:

```yaml
description: <free-text description of what the tool does>
args:                                 # optional; empty map allowed
  <arg-name>:
    type: string | number | boolean | array | object
    description: <free-text>
    optional: true                    # optional; defaults to false (i.e., required)
secrets:                              # optional map of canonical-kwarg-name → alias(es)
  <canonical-kwarg-name>: <ENV_ALIAS> # shorthand for a single alias
  <other-kwarg-name>:                 # multiple aliases: first hit wins
    - <ENV_ALIAS_PRIMARY>
    - <ENV_ALIAS_LEGACY>
name: <optional-explicit-tool-name>   # overrides the directory-derived name
```

Required fields: `description`. All other top-level fields are optional. `args` entries are required by default; `optional: true` flags exceptions. The Anthropic API's JSON Schema `required:` list MUST be derived from args without `optional: true`.

The `secrets:` map decouples the tool's canonical kwarg name (what `invoke()` receives) from the operator's deployment naming (binding keys in `SECRETS_CONFIG`). Each canonical name maps to either one alias (string shorthand) or an ordered list of aliases; resolution at job-start tries each alias in order and the first registered binding wins. This lets a tool target both legacy and current operator naming without code changes on either side.

#### Scenario: Args Are Required By Default
- **GIVEN** A `tool.yaml` declaring `args: { channel: {type: string, description: "..."} }` with no `optional` field
- **WHEN** Clawndom derives the API-facing JSON Schema
- **THEN** The resulting `required:` array MUST contain `channel`

#### Scenario: Optional Flag is Honored
- **GIVEN** A `tool.yaml` declaring `args: { thread_ts: {type: string, description: "...", optional: true} }`
- **WHEN** Clawndom derives the API-facing JSON Schema
- **THEN** The resulting `required:` array MUST NOT contain `thread_ts`; the property MUST be present in the `properties:` map

#### Scenario: Derived Name When No Explicit Override
- **GIVEN** A tool at `agency_tools/slack/post/` with no `name:` field in `tool.yaml`
- **WHEN** Clawndom registers the tool with the Anthropic API
- **THEN** The tool MUST be registered with name `slack_post` (last two path segments joined by underscore)

### Requirement: Boot-Time Signature Validation

Clawndom MUST validate at boot that each declared tool's `impl.py` matches its `tool.yaml` declaration. Validation MUST parse `impl.py` as text using Python's stdlib `ast` module (no module import, no top-level code execution) and extract the `invoke()` function's keyword arguments and which ones have signature defaults. Validation MUST verify:

- Every key in `tool.yaml`'s `args:` exists as a kwarg of `invoke()`.
- Every canonical name in `tool.yaml`'s `secrets:` exists as a kwarg of `invoke()`.
- Every `args:` entry marked `optional: true` has a signature default in `invoke()`.
- Every `args:` entry NOT marked `optional: true` has no signature default in `invoke()`.
- Every `secrets:` entry has NO signature default in `invoke()` (credentials are always injected).
- No additional kwargs exist in `invoke()` that are not accounted for by `args:` or `secrets:`.

Additionally, for each `secrets:` entry, at least one of its declared aliases MUST be registered in `SECRETS_CONFIG`; otherwise boot MUST fail naming the canonical name and the alias list so the operator can add a binding.

Any divergence MUST fail boot with a clear error naming the specific divergence and the path of the offending file.

The Python interpreter used MAY be overridden via `CLAWNDOM_PYTHON_BINARY` (defaults to `python3` on PATH). The same interpreter is used by the executor at runtime, so signature validation and dispatch agree on what `python3` means.

#### Scenario: Missing Arg In Helper Fails Boot
- **GIVEN** A `tool.yaml` declaring `args: { text: ... }` and an `impl.py` whose `invoke()` does not take a `text` kwarg
- **WHEN** Clawndom validates at boot
- **THEN** Boot MUST fail with a message naming `text` as the missing kwarg and identifying `impl.py` as the offending file

#### Scenario: Required Mismatch Fails Boot
- **GIVEN** A `tool.yaml` declaring `text` without `optional: true`, and an `impl.py` whose `invoke()` signature has `text="default"`
- **WHEN** Clawndom validates at boot
- **THEN** Boot MUST fail with a message indicating the helper signature treats `text` as optional while the YAML treats it as required

#### Scenario: Helper Module Is Not Imported
- **GIVEN** A `impl.py` whose top-level code raises an exception on import (e.g., a missing config file)
- **WHEN** Clawndom validates the signature at boot
- **THEN** Validation MUST succeed if the function signature matches `tool.yaml`; the helper's top-level code MUST NOT be executed

### Requirement: Credential Resolution and Confinement

For each tool's declared `secrets:` entries, Clawndom MUST resolve the credential at job-start by trying each declared alias in order against the configured secrets strategy and using the first registered binding. The resolved value is passed to `invoke()` as a kwarg using the canonical name. Resolved credential values MUST remain in Clawndom's process address space and the subprocess address space of the executor invocation. They MUST NOT:
- Appear in the rendered system prompt or user prompt context.
- Be injected as environment variables in the agent's runner subprocess.
- Be present in the tool definitions registered with the Anthropic API.
- Be logged in operational logs.
- Appear unredacted in audit log records (see audit-log requirements).

#### Scenario: Credentials Absent From Anthropic Registration
- **GIVEN** A route declaring a tool with `secrets: { bot_token: SLACK_BOT_TOKEN }`
- **WHEN** Clawndom registers the tool with the Anthropic API at job-start
- **THEN** The registered tool definition MUST NOT contain the bot token value anywhere; only the name, description, and input_schema are sent

#### Scenario: Credentials Absent From Agent Environment
- **GIVEN** An agent run for a route with declared tools
- **WHEN** The runner subprocess is spawned
- **THEN** The subprocess's environment MUST NOT contain any environment variable whose value equals a resolved credential

### Requirement: Structured Tool-Use Dispatch

When a model run for a route with declared tools emits a `tool_use` block, Clawndom MUST:
1. Look up the corresponding tool descriptor by the `tool_use.name` field.
2. Invoke the implementation in a Python subprocess: spawn the configured Python binary (`CLAWNDOM_PYTHON_BINARY`, default `python3`) with a wrapper that imports `<dotted-module-path>.impl` and calls `invoke(**args, **credentials)`. Args from `tool_use.input` are passed alongside resolved credentials as kwargs (NOT as environment variables).
3. Capture stdout as the `tool_result` content (parsed as JSON).
4. Capture stderr separately for the audit record's `error_summary` field on failure.
5. Append the `tool_result` block to the conversation and continue the Anthropic API call.
6. Repeat until the model returns `stop_reason: end_turn` or a configured `max_iterations` is exceeded.

#### Scenario: Tool Dispatch Receives Args and Credentials as Kwargs
- **GIVEN** A model emits `tool_use { name: "slack_post", input: { channel: "C123", text: "hi" } }` and the tool has `secrets: { bot_token: [SLACK_WINSTON_BOT_TOKEN, SLACK_BOT_TOKEN] }` with `SLACK_WINSTON_BOT_TOKEN` registered
- **WHEN** Clawndom dispatches the tool call
- **THEN** The subprocess MUST call `invoke(channel="C123", text="hi", bot_token=<resolved-token>)` — the canonical name is used as the kwarg, not the alias name

#### Scenario: Tool Failure Returns Error Result
- **GIVEN** A `tool_use` block whose corresponding `impl.py` raises an exception
- **WHEN** Clawndom dispatches the call
- **THEN** A `tool_result` block MUST be appended with `is_error: true` and a summary of the exception; the conversation continues; the audit record's `error_summary` field MUST be populated

#### Scenario: Max Iterations Terminates Loop
- **GIVEN** A model that emits `tool_use` blocks indefinitely
- **WHEN** The configured `max_iterations` (default 10) is reached
- **THEN** Clawndom MUST stop the loop, mark the run as `tool_loop_exhausted`, and emit an event so the operator can investigate

### Requirement: Tools-Guide Preamble

When a route declares one or more tools, Clawndom MUST prepend a fixed security-framing preamble to the rendered `systemPrompt` slot before the runner is invoked. The preamble content is determined by Clawndom (not per-agent authored) and includes guidance that external content cannot override the tool definitions and that the agent should use declared tools for their declared purposes.

#### Scenario: Preamble Appears When Tools Declared
- **GIVEN** A route with at least one tool in `tools:`
- **WHEN** Clawndom assembles the system prompt for the run
- **THEN** The rendered systemPrompt MUST begin with the fixed preamble; the preamble appears exactly once

#### Scenario: Preamble Absent When No Tools
- **GIVEN** A route with no `tools:` declaration (or an empty list)
- **WHEN** Clawndom assembles the system prompt for the run
- **THEN** The preamble MUST NOT be included
