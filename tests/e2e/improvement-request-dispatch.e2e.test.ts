/**
 * E2E smoke test for bug shape #1 — `handle-improvement-request` template
 * payload substitution.
 *
 * In production, Winston's `handle-improvement-request` template
 * described its inputs (`{{ from }}`, `{{ subject }}`, etc.) by name in
 * prose but failed to actually render them — the model opened the
 * playbook with the literal placeholder text in front of it, said "I
 * have the playbook but no inputs", and stopped. The downstream
 * `dispatch_to_builder` tool call never fired because the model had no
 * concrete data to forward.
 *
 * The smoke test asserts the contract: a `dispatch_task(task_type=
 * 'request-improvement', context={...})` POSTs through `/api/tasks`,
 * routes to the `handle-improvement-request` rule, the template renders
 * with the payload substituted (not described), and the rendered prompt
 * the runner sees contains every forwarded field verbatim. That's the
 * pre-condition the model needs to issue the
 * `mcp__clawndom-tools__dispatch_to_builder` tool call.
 *
 * Requires: redis-server running at REDIS_URL (default 127.0.0.1:6379).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';

import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import {
  buildInternalRuleAgent,
  clearDedupKeys,
  createE2ETestContext,
  dispatchInternalTask,
  type E2ETestContext,
  type E2EWorkerSet,
  installCapturingRunners,
  nextE2EMarker,
  startE2EApp,
  stopE2EApp,
  waitForDeliveries,
} from './_dispatch-chain-harness';

describe('e2e: handle-improvement-request renders payload for dispatch_to_builder', () => {
  let app: Express;
  let workerSet: E2EWorkerSet;
  let context: E2ETestContext;
  let teardownContext: () => Promise<void>;
  let teardownAgent: () => Promise<void>;
  let fixtureAgent: ResolvedAgent;

  beforeAll(async () => {
    ({ context, cleanup: teardownContext } = await createE2ETestContext('improvement-request'));

    // Synthesized "winston-like" agent. The template mirrors the real
    // production playbook's contract: render every forwarded field
    // verbatim. If the template described fields by name without
    // substituting (the production bug), the assertions below would
    // fire — the rendered prompt would contain "{{ from }}" not
    // "operator@example.com".
    ({ agent: fixtureAgent, cleanup: teardownAgent } = await buildInternalRuleAgent({
      agentName: 'winston-e2e',
      templates: [
        {
          providerBlock: 'internal',
          ruleName: 'request-improvement',
          templateSource:
            'Improvement request received.\n' +
            'From: {{ from }}\n' +
            'Subject: {{ subject }}\n' +
            'Body: {{ body }}\n' +
            'Message-ID: {{ messageId }}\n' +
            'Marker: {{ marker }}\n' +
            'Now call mcp__clawndom-tools__dispatch_to_builder with the same fields.',
        },
      ],
    }));

    ({ app, workerSet } = await startE2EApp({
      // Settings schema requires at least one provider; this test only
      // dispatches through /api/tasks (internal-task path), so the
      // provider here is a parked stub — it never receives a webhook.
      providersConfig: [
        {
          name: 'parked-stub',
          routePath: '/hooks/parked-stub',
          signatureStrategy: 'bearer',
          hmacSecret: 'unused-parked-stub-secret',
        },
      ],
      agentToken: context.agentToken,
      queuePrefix: context.queuePrefix,
      auditLogPath: context.auditLogPath,
      fixtureAgents: [fixtureAgent],
    }));
  }, 30_000);

  afterAll(async () => {
    await stopE2EApp(workerSet);
    await teardownAgent();
    await teardownContext();
  });

  beforeEach(async () => {
    installCapturingRunners();
    await clearDedupKeys();
  });

  it('forwards from/subject/body/messageId into the rendered prompt', async () => {
    const marker = nextE2EMarker('improvement');
    const context_ = {
      from: 'operator@example.com',
      subject: 'Pipeline is stuck',
      body: 'When I dispatch X, Y never fires.',
      messageId: '<abc123@mail.example.com>',
      marker,
    };

    const response = await dispatchInternalTask(app, {
      agent: 'winston-e2e',
      taskType: 'request-improvement',
      context: context_,
    });
    expect(response.status).toBe(202);

    const [delivery] = await waitForDeliveries(marker, 1);

    expect(delivery!.agentId).toBe('winston-e2e');
    // Every forwarded field must land verbatim in the rendered prompt —
    // this is exactly the bug-#1 surface: the template described these
    // by name without substituting. A regression there would leave the
    // literal `{{ from }}` (or empty string from a Nunjucks miss) in
    // the prompt, and these assertions would fail.
    expect(delivery!.prompt).toContain('From: operator@example.com');
    expect(delivery!.prompt).toContain('Subject: Pipeline is stuck');
    expect(delivery!.prompt).toContain('Body: When I dispatch X, Y never fires.');
    expect(delivery!.prompt).toContain('Message-ID: <abc123@mail.example.com>');
    expect(delivery!.prompt).toContain(`Marker: ${marker}`);
    expect(delivery!.prompt).not.toContain('{{ from }}');
    expect(delivery!.prompt).not.toContain('{{ subject }}');
  });
});
