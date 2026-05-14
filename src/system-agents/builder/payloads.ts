import { z } from 'zod';

const slackEnvelope = z.object({
  channel: z.literal('slack'),
  threadTs: z.string().min(1),
  channelId: z.string().min(1),
  senderId: z.string().email(),
  originalRequestText: z.string().min(1),
});

const emailEnvelope = z.object({
  channel: z.literal('email'),
  messageId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  senderId: z.string().email(),
  originalRequestText: z.string().min(1),
});

/**
 * Channel-natural locator + originator info Builder echoes back on every
 * callback. Builder treats this as opaque — never inspects, alters, or
 * logs it beyond a hash.
 */
export const replyContextEnvelopeSchema = z.discriminatedUnion('channel', [
  slackEnvelope,
  emailEnvelope,
]);

export type ReplyContextEnvelope = z.infer<typeof replyContextEnvelopeSchema>;

const resumePayloadSchema = z.object({
  branch: z.string().min(1),
  answer: z.string().min(1),
});

/**
 * Dispatch payload posted to `POST /webhooks/system/builder` by an
 * opted-in agent on its privileged route. `agentName` is resolved against
 * `AGENTS_CONFIG` to find the dispatching agent's repo, path, Builder bot
 * credentials, branch convention, and operator allowlist.
 */
export const builderDispatchPayloadSchema = z
  .object({
    agentName: z.string().min(1),
    request: z.string().min(1),
    replyContext: replyContextEnvelopeSchema,
    senderIdentity: z.string().email(),
    resume: resumePayloadSchema.optional(),
  })
  .strict();

export type BuilderDispatchPayload = z.infer<typeof builderDispatchPayloadSchema>;

const builderStateEnum = z.enum(['working', 'question_pending', 'testable', 'failed']);

export type BuilderState = z.infer<typeof builderStateEnum>;

const workingCallback = z.object({
  eventId: z.string().min(1),
  state: z.literal('working'),
  replyContext: replyContextEnvelopeSchema,
});

const questionPendingCallback = z.object({
  eventId: z.string().min(1),
  state: z.literal('question_pending'),
  replyContext: replyContextEnvelopeSchema,
  question: z.string().min(1),
  branch: z.string().min(1),
  planPath: z.string().min(1),
});

const testableCallback = z.object({
  eventId: z.string().min(1),
  state: z.literal('testable'),
  replyContext: replyContextEnvelopeSchema,
  prUrl: z.string().url(),
  testUrl: z.string().url().optional(),
});

const failedCallback = z.object({
  eventId: z.string().min(1),
  state: z.literal('failed'),
  replyContext: replyContextEnvelopeSchema,
  reason: z.string().min(1),
});

/**
 * Callback payload posted by Builder's runner (or the deploy-complete
 * webhook handler) to `POST /webhooks/builder-callback`. The route dedupes
 * on `eventId` (`<job_id>:<state_name>`) against a Redis-backed store.
 */
export const builderCallbackPayloadSchema = z.discriminatedUnion('state', [
  workingCallback,
  questionPendingCallback,
  testableCallback,
  failedCallback,
]);

export type BuilderCallbackPayload = z.infer<typeof builderCallbackPayloadSchema>;

/**
 * Payload the external supervisor (PM2, systemd, k8s) posts to
 * `POST /webhooks/builder-deploy-complete` after restarting clawndom for
 * a Builder PR. The job ID identifies which paused job to fire `testable`
 * (or `failed`) on.
 */
export const builderDeployCompletePayloadSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.enum(['ok', 'failed']),
    reason: z.string().min(1).optional(),
  })
  .strict();

export type BuilderDeployCompletePayload = z.infer<typeof builderDeployCompletePayloadSchema>;
