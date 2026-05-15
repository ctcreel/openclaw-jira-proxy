import { describe, it, expect, vi } from 'vitest';

import type { AgentConfig, ResolvedAgent } from '../../../src/services/agent-loader.service';
import type { AgentEntry } from '../../../src/config';
import { validateBuilderDispatchSenderGate } from '../../../src/system-agents/builder/sender-gate';

vi.mock('../../../src/lib/logging', () => ({
  getLogger: (): Record<string, ReturnType<typeof vi.fn>> => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  setupLogging: vi.fn(),
  resetLogging: vi.fn(),
}));

const EMAIL_ENVELOPE = {
  channel: 'email',
  messageId: '<m@m>',
  threadId: 't-1',
  senderEmail: 'heather@talkatlanta.info',
  originalRequestText: 'please add a daily mood-check',
};

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentName: 'winston',
    request: 'please add a daily mood-check question to drafts',
    replyContext: EMAIL_ENVELOPE,
    senderEmail: 'heather@talkatlanta.info',
    ...overrides,
  };
}

const EMPTY_AGENT_CONFIG: AgentConfig = { routing: {}, modelRules: {} };

function buildAgent(overrides: Partial<AgentEntry> = {}): ResolvedAgent {
  const entry: AgentEntry = {
    name: 'winston',
    repo: 'git@github.com:ctcreel/winston-agency.git',
    operatorAllowlist: ['heather@talkatlanta.info', 'chris@talkatlanta.info'],
    ...overrides,
  };
  return {
    name: entry.name,
    dir: '/scratch/winston',
    config: EMPTY_AGENT_CONFIG,
    entry,
  };
}

describe('validateBuilderDispatchSenderGate', () => {
  it('accepts an allowlisted sender', () => {
    const result = validateBuilderDispatchSenderGate(buildPayload(), [buildAgent()]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.senderEmail).toBe('heather@talkatlanta.info');
    }
  });

  it('refuses an unknown agentName with 403', () => {
    const result = validateBuilderDispatchSenderGate(buildPayload({ agentName: 'patches' }), [
      buildAgent(),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('Dispatch not allowed.');
      expect(result.reason).toMatch(/unknown-agent/);
    }
  });

  it('refuses a non-allowlisted sender with 403 and no telling reason in the body', () => {
    const result = validateBuilderDispatchSenderGate(
      buildPayload({
        senderEmail: 'parent@example.com',
        replyContext: { ...EMAIL_ENVELOPE, senderEmail: 'parent@example.com' },
      }),
      [buildAgent()],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('Dispatch not allowed.');
      // Body MUST NOT leak the agent name, sender email, or allowlist concept.
      expect(JSON.stringify(result.body)).not.toContain('winston');
      expect(JSON.stringify(result.body)).not.toContain('parent@example.com');
      expect(JSON.stringify(result.body).toLowerCase()).not.toContain('allowlist');
      expect(JSON.stringify(result.body).toLowerCase()).not.toContain('sender');
      // The reason field (server-side logging only) should explain.
      expect(result.reason).toMatch(/sender-not-allowed/);
      // Reason logs the DOMAIN (not the full email) — defense against
      // PII landing in server logs even on the refusal path.
      expect(result.reason).toContain('senderDomain=example.com');
      expect(result.reason).not.toContain('parent@example.com');
    }
  });

  it('refuses a malformed payload with 400', () => {
    const result = validateBuilderDispatchSenderGate({ not: 'a-dispatch' }, [buildAgent()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Invalid dispatch payload.');
      expect(result.reason).toMatch(/payload-validation/);
    }
  });

  it('passes through (with warning) when the dispatching agent has no operatorAllowlist', () => {
    const agentWithoutAllowlist = buildAgent({ operatorAllowlist: undefined });
    const result = validateBuilderDispatchSenderGate(buildPayload(), [agentWithoutAllowlist]);
    expect(result.ok).toBe(true);
  });

  it('refuses everyone when operatorAllowlist is empty (fail-closed for the explicit empty case)', () => {
    const agentWithEmptyAllowlist = buildAgent({ operatorAllowlist: [] });
    const result = validateBuilderDispatchSenderGate(buildPayload(), [agentWithEmptyAllowlist]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toMatch(/sender-not-allowed/);
    }
  });

  it('passes through (with warning) for a system agent (entry === undefined)', () => {
    const systemAgent: ResolvedAgent = {
      name: 'winston',
      dir: '/path',
      config: EMPTY_AGENT_CONFIG,
      // entry deliberately omitted
    };
    const result = validateBuilderDispatchSenderGate(buildPayload(), [systemAgent]);
    expect(result.ok).toBe(true);
  });
});
