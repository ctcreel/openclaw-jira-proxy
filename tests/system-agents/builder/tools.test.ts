import { describe, it, expect } from 'vitest';

import {
  BUILDER_TOOLS,
  FORBIDDEN_BUILDER_TOOLS,
  isForbiddenBuilderTool,
} from '../../../src/system-agents/builder/tools';

describe('Builder tool list', () => {
  it('exposes only repo-modification tools (clone/branch/edit/commit/push/PR/check)', () => {
    expect([...BUILDER_TOOLS]).toEqual([
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
    ]);
  });

  it('excludes Slack outbound tools', () => {
    for (const name of BUILDER_TOOLS) {
      expect(name.toLowerCase()).not.toMatch(/slack/);
    }
  });

  it('excludes Gmail / email outbound tools', () => {
    for (const name of BUILDER_TOOLS) {
      expect(name.toLowerCase()).not.toMatch(/gmail|email_send|mail_send/);
    }
  });

  it('excludes arbitrary webhook-post tools', () => {
    for (const name of BUILDER_TOOLS) {
      expect(name.toLowerCase()).not.toMatch(/webhook/);
    }
  });

  it('forbidden tool sentinel list covers all major user-channel tools', () => {
    expect([...FORBIDDEN_BUILDER_TOOLS]).toEqual(
      expect.arrayContaining([
        'slack_send',
        'slack_post_message',
        'slack_reply',
        'gmail_send',
        'gmail_reply',
        'email_send',
        'webhook_post',
      ]),
    );
  });

  it('isForbiddenBuilderTool matches forbidden names exactly', () => {
    for (const name of FORBIDDEN_BUILDER_TOOLS) {
      expect(isForbiddenBuilderTool(name)).toBe(true);
    }
    for (const name of BUILDER_TOOLS) {
      expect(isForbiddenBuilderTool(name)).toBe(false);
    }
    expect(isForbiddenBuilderTool('not_a_tool')).toBe(false);
  });
});
