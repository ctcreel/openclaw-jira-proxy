/**
 * Builder's tool list. Section 5 (the runner) is responsible for wiring
 * these names to concrete implementations against the dispatching agent's
 * repo. This file is the *manifest* — it answers "what can Builder do?"
 * and is the unit test surface for "Builder never gets a user-channel
 * tool."
 */

/**
 * Repo-modification tools Builder uses to do her job. The set is
 * deliberately small: enough to inspect, branch, edit, verify, and PR;
 * nothing else.
 */
export const BUILDER_TOOLS = [
  'clone_repo',
  'fetch_origin',
  'create_branch',
  'read_file',
  'edit_file',
  'write_file',
  'commit',
  'push',
  'open_pr',
  'delete_remote_branch',
  'run_check_all',
] as const;

export type BuilderToolName = (typeof BUILDER_TOOLS)[number];

/**
 * Tool names that MUST NOT appear in Builder's tool list. Operator-facing
 * communication flows through the dispatching agent via callbacks; Builder
 * has no voice of her own. The list is the explicit denial surface so
 * a future contributor who tries to "let Builder reply directly" gets a
 * failing test at the spec layer.
 */
export const FORBIDDEN_BUILDER_TOOLS = [
  'slack_send',
  'slack_post_message',
  'slack_reply',
  'gmail_send',
  'gmail_reply',
  'email_send',
  'webhook_post',
] as const;

export type ForbiddenToolName = (typeof FORBIDDEN_BUILDER_TOOLS)[number];

export function isForbiddenBuilderTool(name: string): boolean {
  const forbidden: readonly string[] = FORBIDDEN_BUILDER_TOOLS;
  return forbidden.includes(name);
}
