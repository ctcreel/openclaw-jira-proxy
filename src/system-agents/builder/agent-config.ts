import { z } from 'zod';

const deployWebhookMechanism = z.object({
  type: z.literal('deploy_webhook'),
  /**
   * URL the external supervisor (PM2, systemd, k8s) calls after a successful
   * clawndom restart to fire the `testable` callback. Stored on the agent's
   * config so the agent's runtime can hand it to the supervisor at provision
   * time.
   */
  webhookUrl: z.string().url(),
});

const cacheRefreshMechanism = z.object({
  type: z.literal('cache_refresh'),
});

const prPreviewMechanism = z.object({
  type: z.literal('pr_preview'),
  /**
   * Identifier the workspace uses to resolve a preview URL for a given PR
   * (e.g., a Vercel project slug, a Render service id). The agent's runtime
   * is responsible for turning this into the preview URL it reports on the
   * `testable` callback.
   */
  previewResolver: z.string().min(1),
});

export const testableMechanismSchema = z.discriminatedUnion('type', [
  deployWebhookMechanism,
  cacheRefreshMechanism,
  prPreviewMechanism,
]);

export type TestableMechanism = z.infer<typeof testableMechanismSchema>;

/**
 * Builder-specific extensions on an `AgentEntry`. Every field is optional at
 * the schema level; an agent that omits all of them is simply not opted in
 * to Builder. An agent that opts in MUST declare at least `builderBotRef`,
 * `operatorAllowlist`, and `testableMechanism`; the cross-field check runs
 * after the schema parses (see `validateBuilderAgentFields`).
 */
export const builderAgentFieldsSchema = z.object({
  /**
   * Logical secret key (resolved via SecretManager) for the per-repo Builder
   * GitHub App credentials used to author PRs in the dispatching agent's
   * repo. Colocated agents share this ref because they share the repo.
   */
  builderBotRef: z.string().min(1).optional(),
  /**
   * Branch-naming pattern Builder uses for working branches in this agent's
   * repo. Omit to use the default (`builder/<kebab-summary>`).
   */
  branchNamingPattern: z.string().min(1).optional(),
  /**
   * Flat list of operator email addresses allowed to dispatch Builder
   * requests on this agent's privileged route. Slack-channel dispatching
   * agents MUST resolve `user_id` → email before dispatching. Empty list is
   * valid and refuses all dispatches.
   */
  operatorAllowlist: z.array(z.string().email()).optional(),
  /**
   * How a Builder change becomes live for this agent. Defaults to
   * `deploy_webhook` for clawndom-resident agents in v1; once hot-reload
   * lands the default may shift to `cache_refresh`.
   */
  testableMechanism: testableMechanismSchema.optional(),
});

export type BuilderAgentFields = z.infer<typeof builderAgentFieldsSchema>;

/**
 * An agent is "opted in to Builder" iff `builderBotRef` is set. Opt-in
 * requires the full triple `{builderBotRef, operatorAllowlist, testableMechanism}`
 * to be declared. The check runs after the surrounding agent schema has
 * parsed because Zod can't express "if A is set then B and C must be" on
 * a single optional triple without a custom refinement on the parent.
 */
export function isOptedInToBuilder(fields: BuilderAgentFields): boolean {
  return fields.builderBotRef !== undefined;
}

export function validateBuilderAgentFields(agentName: string, fields: BuilderAgentFields): void {
  if (!isOptedInToBuilder(fields)) {
    return;
  }
  const missing: string[] = [];
  if (fields.operatorAllowlist === undefined) {
    missing.push('operatorAllowlist');
  }
  if (fields.testableMechanism === undefined) {
    missing.push('testableMechanism');
  }
  if (missing.length > 0) {
    throw new Error(
      `Agent ${agentName} sets builderBotRef but is missing required Builder fields: ${missing.join(', ')}. Either declare all three (builderBotRef, operatorAllowlist, testableMechanism) or none.`,
    );
  }
}
