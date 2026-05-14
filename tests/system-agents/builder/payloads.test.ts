import { describe, it, expect } from 'vitest';

import {
  builderCallbackPayloadSchema,
  builderDeployCompletePayloadSchema,
  builderDispatchPayloadSchema,
  replyContextEnvelopeSchema,
} from '../../../src/system-agents/builder/payloads';

const slackEnvelope = {
  channel: 'slack' as const,
  threadTs: '1700000000.000100',
  channelId: 'C0123456',
  senderEmail: 'heather@example.com',
  originalRequestText: 'Please help with onboarding',
};

const emailEnvelope = {
  channel: 'email' as const,
  messageId: '<abc@example.com>',
  threadId: 'thread-123',
  senderEmail: 'heather@example.com',
  originalRequestText: 'Please help with onboarding',
};

describe('replyContextEnvelopeSchema', () => {
  it('accepts a slack envelope', () => {
    expect(replyContextEnvelopeSchema.parse(slackEnvelope)).toEqual(slackEnvelope);
  });

  it('accepts an email envelope (threadId optional)', () => {
    expect(replyContextEnvelopeSchema.parse(emailEnvelope)).toEqual(emailEnvelope);
  });

  it('rejects an envelope with an unknown channel', () => {
    expect(() =>
      replyContextEnvelopeSchema.parse({ ...slackEnvelope, channel: 'teams' }),
    ).toThrow();
  });

  it('rejects a slack envelope missing threadTs', () => {
    const broken = { ...slackEnvelope } as Record<string, unknown>;
    delete broken.threadTs;
    expect(() => replyContextEnvelopeSchema.parse(broken)).toThrow();
  });

  it('rejects a non-email senderEmail', () => {
    expect(() =>
      replyContextEnvelopeSchema.parse({ ...slackEnvelope, senderEmail: 'not-an-email' }),
    ).toThrow();
  });
});

describe('builderDispatchPayloadSchema', () => {
  const validDispatch = {
    agentName: 'winston',
    request: 'Add a helper that summarizes daily standups',
    replyContext: slackEnvelope,
    senderEmail: 'heather@example.com',
  };

  it('accepts a minimal valid dispatch', () => {
    expect(builderDispatchPayloadSchema.parse(validDispatch)).toEqual(validDispatch);
  });

  it('accepts a dispatch with a resume payload', () => {
    const parsed = builderDispatchPayloadSchema.parse({
      ...validDispatch,
      resume: { branch: 'builder/standups-helper', answer: 'Use Slack only.' },
    });
    expect(parsed.resume?.branch).toBe('builder/standups-helper');
  });

  it('rejects a dispatch with unknown fields (strict)', () => {
    expect(() =>
      builderDispatchPayloadSchema.parse({ ...validDispatch, extraSurpriseField: 'oh no' }),
    ).toThrow();
  });

  it('rejects a dispatch missing agentName', () => {
    const broken = { ...validDispatch } as Record<string, unknown>;
    delete broken.agentName;
    expect(() => builderDispatchPayloadSchema.parse(broken)).toThrow();
  });

  it('rejects a non-email senderEmail in the dispatch', () => {
    expect(() =>
      builderDispatchPayloadSchema.parse({ ...validDispatch, senderEmail: 'heather' }),
    ).toThrow();
  });
});

describe('builderCallbackPayloadSchema', () => {
  const base = { replyContext: slackEnvelope };

  it('accepts a working callback', () => {
    expect(
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:working',
        state: 'working',
      }),
    ).toBeDefined();
  });

  it('accepts a question_pending callback with the required extras', () => {
    expect(
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:question_pending',
        state: 'question_pending',
        question: 'Should this default to Slack DMs or channel posts?',
        branch: 'builder/standups-helper',
        planPath: '.builder/plan.md',
      }),
    ).toBeDefined();
  });

  it('accepts a testable callback with prUrl', () => {
    expect(
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:testable',
        state: 'testable',
        prUrl: 'https://github.com/org/the-agency/pull/42',
      }),
    ).toBeDefined();
  });

  it('accepts a testable callback with optional testUrl', () => {
    expect(
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:testable',
        state: 'testable',
        prUrl: 'https://github.com/org/the-agency/pull/42',
        testUrl: 'https://preview-42.example.com',
      }),
    ).toBeDefined();
  });

  it('accepts a failed callback with reason', () => {
    expect(
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:failed',
        state: 'failed',
        reason: 'Request requires modifying clawndom; out of scope.',
      }),
    ).toBeDefined();
  });

  it('rejects a question_pending callback missing extras', () => {
    expect(() =>
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:question_pending',
        state: 'question_pending',
      }),
    ).toThrow();
  });

  it('rejects an unknown state', () => {
    expect(() =>
      builderCallbackPayloadSchema.parse({
        ...base,
        eventId: 'job-1:weird',
        state: 'weird',
      }),
    ).toThrow();
  });
});

describe('builderDeployCompletePayloadSchema', () => {
  it('accepts ok status', () => {
    expect(
      builderDeployCompletePayloadSchema.parse({ jobId: 'job-1', status: 'ok' }),
    ).toBeDefined();
  });

  it('accepts failed status with reason', () => {
    expect(
      builderDeployCompletePayloadSchema.parse({
        jobId: 'job-1',
        status: 'failed',
        reason: 'Service failed health check after restart',
      }),
    ).toBeDefined();
  });

  it('rejects unknown status', () => {
    expect(() =>
      builderDeployCompletePayloadSchema.parse({ jobId: 'job-1', status: 'partial' }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      builderDeployCompletePayloadSchema.parse({
        jobId: 'job-1',
        status: 'ok',
        bonus: 'no',
      }),
    ).toThrow();
  });
});
