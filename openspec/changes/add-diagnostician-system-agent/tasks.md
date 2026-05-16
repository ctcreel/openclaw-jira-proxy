# Implementation tasks

Order: credentials + read-only boundary land first; routes + tool registration last. The principle is the same as Builder's: any code that could dispatch must come after the structural defense it relies on.

## 1. Credentials and identity

- [ ] Create the GitHub App `sc0red-diagnostician[bot]` with **read-only** repo permissions (contents:read, pull-requests:read, issues:read, metadata:read). No write permissions of any kind.
- [ ] Register the 1Password item `"GitHub App: sc0red-diagnostician"` in `Engineering` with the App ID + private key.
- [ ] Confirm the bot is in the per-workspace-repo bot-allowlist for the workspaces it should read (winston-agency at minimum).

## 2. Schema + agent definition

- [ ] Add `diagnostician/` under `src/system-agents/` with the same shape as `builder/`:
  - `prompt.md` — read-only contract, operator-language translation rules, vocabulary firewall.
  - `agent-config.ts` — minimum fields required on the dispatching agent's `AGENTS_CONFIG` entry to opt into Diagnostician (`diagnosticianBotRef` only; no `operatorAllowlist` needed since Diagnostician inherits the dispatching agent's allowlist).
  - `payloads.ts` — `diagnosticianDispatchPayloadSchema` (`{agentName, question, replyContext, senderEmail, resume?}`) and `diagnosticianCallbackPayloadSchema` (`working`, `complete`, `failed`).
  - `templates/dispatch.njk` — the prompt body, including the optional resume block.
  - `report-template.md` — the structured-report skeleton Diagnostician fills in.

## 3. Routes

- [ ] Add `POST /webhooks/system/diagnostician` route + controller, gated by the internal-bearer strategy (same as Builder's `/webhooks/system/builder`).
- [ ] Add `POST /webhooks/diagnostician-callback` route + controller, gated by internal-bearer.
- [ ] Wire both routes in `src/routes/index.ts`.

## 4. Queues and runner

- [ ] Add `diagnostician-dispatch` and `diagnostician-callback` BullMQ providers in `src/services/queue.service.ts`.
- [ ] Add a `diagnostician` system-agent loader alongside Builder in `src/system-agents/index.ts` (or equivalent).

## 5. Tool: dispatch_to_diagnostician

- [ ] Add `dispatch_to_diagnostician` to `agency-tools` under the same MCP-bridge pattern as `dispatch_to_builder`. Scope: explicit privileged-route attachment only; do **not** auto-attach to civilian routes.
- [ ] Update Winston's `email-chat.md` to detect "explain X" / "why did you Y" requests from Tier 1 senders and dispatch them.

## 6. Report generation + relay

- [ ] Diagnostician opens a draft PR in a `diagnostician-reports` repo (or a `reports/` subdirectory of the dispatching agent's repo — pick during design) with the structured report as the body.
- [ ] On `complete`, the callback handler routes back to the dispatching agent's `relay-diagnostician-callback` template (analog of `relay-builder-callback.md`), which translates the report into operator-language and emails the requester.

## 7. Tests

- [ ] Payload schema tests (`tests/system-agents/diagnostician/payloads.test.ts`).
- [ ] Dispatch integration test (mirrors Builder's: 202 + correct routing).
- [ ] Callback integration test.
- [ ] Read-only credentials test: assert that Diagnostician's bot identity does not have write scopes on any workspace repo it can read.

## 8. Documentation

- [ ] Add an entry to `docs/guides/SYSTEM_AGENTS.md` (creating it if absent) describing Diagnostician + Builder side-by-side.
