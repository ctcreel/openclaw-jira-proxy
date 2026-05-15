import type { ResolvedAgent } from '../../services/agent-loader.service';
import { getLogger } from '../../lib/logging';

import { builderDispatchPayloadSchema } from './payloads';
import type { BuilderDispatchPayload } from './payloads';

const logger = getLogger('builder:sender-gate');

/**
 * Outcome of running the Layer-3 operator-allowlist gate against a Builder
 * dispatch payload. The webhook controller branches on the discriminator:
 * `ok: true` lets the event proceed to ingest; everything else short-
 * circuits with an HTTP status.
 *
 * The `body` field on a refusal is deliberately uninformative — the
 * controller responds with it verbatim. We don't surface "your sender
 * email isn't in agentX's operatorAllowlist" or even name Builder; the
 * caller (presumably a dispatching agent's privileged route) already
 * checked authorization at Layer 2, so a sender that's reached us is
 * either a misconfigured dispatcher or a hostile bypass. Either way the
 * answer is "no", not "no, because…".
 */
export type SenderGateOutcome =
  | { ok: true; payload: BuilderDispatchPayload }
  | { ok: false; status: number; body: { error: string }; reason: string };

/**
 * Layer-3 of the operator-allowlist enforcement model for Builder
 * dispatches.
 *
 * - Layer 1 (structural): the `dispatch_to_builder` tool is loaded only on a
 *   privileged route — civilian routes can't even *attempt* a dispatch.
 * - Layer 2 (template): the privileged route's template re-checks sender
 *   against an inline allowlist before invoking `dispatch_to_builder`.
 * - Layer 3 (this gate): clawndom re-checks sender against the *dispatching
 *   agent's* `operatorAllowlist` at the HTTP boundary, before the event
 *   reaches the queue. If a template-injection or future contributor wires
 *   a new dispatch path without the inline check, this catches it.
 *
 * Both validation failures (malformed payload) and authorization failures
 * (sender not allowlisted) return the same uninformative 403 to avoid
 * telegraphing internals to a hostile caller. Operators discover the real
 * reason in the server log.
 */
export function validateBuilderDispatchSenderGate(
  rawPayload: unknown,
  agents: readonly ResolvedAgent[],
): SenderGateOutcome {
  const parsed = builderDispatchPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid dispatch payload.' },
      reason: `payload-validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const payload = parsed.data;

  const dispatchingAgent = agents.find((agent) => agent.name === payload.agentName);
  if (!dispatchingAgent) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Dispatch not allowed.' },
      reason: `unknown-agent: agentName=${payload.agentName} not in loaded agents`,
    };
  }

  const allowlist = getOperatorAllowlist(dispatchingAgent);
  if (allowlist === undefined) {
    // No allowlist configured on this agent. Layer-3 is unenforced for the
    // dispatching agent — this is a deploy-time gap, not a runtime fail.
    // Log a warning so the operator sees they should set one, but pass the
    // event through; Layer 1 + Layer 2 are still in front of Builder.
    // Sender domain only — full email is PII we don't want in logs.
    logger.warn(
      { agentName: payload.agentName, senderDomain: getSenderDomain(payload.senderEmail) },
      'Layer-3 operator-allowlist not configured on dispatching agent; ' +
        'Builder dispatch proceeds on Layer 1/2 only. Set operatorAllowlist ' +
        "on this agent's config for defense in depth.",
    );
    return { ok: true, payload };
  }

  if (!allowlist.includes(payload.senderEmail)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Dispatch not allowed.' },
      // Reason is for server-side logs only; we name the agent and the
      // sender's DOMAIN but never the full email. Operators triaging this
      // can grep their inbound mail or the dispatch payload (kept in
      // BullMQ for the retry window) for the full address when needed.
      reason: `sender-not-allowed: agent=${payload.agentName} senderDomain=${getSenderDomain(payload.senderEmail)}`,
    };
  }

  return { ok: true, payload };
}

function getOperatorAllowlist(agent: ResolvedAgent): readonly string[] | undefined {
  // The agent's `entry` (from AGENTS_CONFIG) carries the optional
  // `operatorAllowlist` per `builderAgentFieldsSchema`. `entry` is
  // populated by the workspace-agent loader; system agents (Builder
  // herself, etc.) carry `entry === undefined` because they aren't
  // loaded from AGENTS_CONFIG — in that case there's nothing to
  // enforce and we fall back to the "Layer-3 unenforced" warning path.
  return agent.entry?.operatorAllowlist;
}

function getSenderDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '<no-domain>' : email.slice(at + 1);
}
