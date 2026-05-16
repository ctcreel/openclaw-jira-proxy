import { describe, it, expect } from 'vitest';

import { processEdits, editPayloadSchema } from '../../src/services/workspace-edit.service';

const FIXTURE_WITH_COMMENTS = `# Top-level Winston routing config.
#
# This block is the audit trail for major decisions — keep it.
routing:
  # gmail-pubsub: Heather's inbox triage.
  # Detailed: this rule was added in SPE-1774; the matcher is the
  # emailAddress field on the inner Pub/Sub payload. Don't change
  # without coordinating with the gmail watch refresh task.
  gmail-pubsub:
    rules:
      - name: triage-heather-inbox
        # Condition: match on emailAddress. Drives downstream routing.
        condition:
          equals:
            field: emailAddress
            value: heather@talkatlanta.info
        messageTemplate: templates/inbox-triage.md
        tools:
          - module.python: agency_tools.google.gmail_search

      - name: email-chat-winston
        # winston@'s mailbox — direct chat.
        condition:
          equals:
            field: emailAddress
            value: winston@talkatlanta.info
        messageTemplate: templates/email-chat.md

  internal:
    rules:
      - name: draft-response
        condition:
          equals: { field: taskType, value: draft-response }
        messageTemplate: templates/draft-responses.md

modelRules:
  gmail-pubsub: []
`;

describe('processEdits — AST-level rule operations preserve comments', () => {
  it('preserves the block-level decision comments verbatim when updating a rule', () => {
    const result = processEdits(FIXTURE_WITH_COMMENTS, {
      message: 'tighten inbox-triage tools',
      description: '',
      edits: [
        {
          op: 'rule.update',
          provider: 'gmail-pubsub',
          ruleName: 'triage-heather-inbox',
          changes: {
            tools: [{ 'module.python': 'agency_tools.google.gmail_label' }],
          },
        },
      ],
    });

    expect(result.yaml).toContain("# gmail-pubsub: Heather's inbox triage.");
    expect(result.yaml).toContain('this rule was added in SPE-1774');
    expect(result.yaml).toContain("Don't change");
    expect(result.yaml).toContain('agency_tools.google.gmail_label');
    expect(result.yaml).not.toContain('agency_tools.google.gmail_search');
  });

  it('preserves comments on rules untouched by an update', () => {
    const result = processEdits(FIXTURE_WITH_COMMENTS, {
      message: 'tweak triage tools',
      description: '',
      edits: [
        {
          op: 'rule.update',
          provider: 'gmail-pubsub',
          ruleName: 'triage-heather-inbox',
          changes: { messageTemplate: 'templates/new-triage.md' },
        },
      ],
    });

    // The comment on email-chat-winston (the OTHER rule under
    // gmail-pubsub) should be untouched.
    expect(result.yaml).toContain("# winston@'s mailbox — direct chat.");
  });

  it('appends a new rule under the named provider, comments on existing rules untouched', () => {
    const result = processEdits(FIXTURE_WITH_COMMENTS, {
      message: 'add a builder-callback rule',
      description: '',
      edits: [
        {
          op: 'rule.add',
          provider: 'internal',
          rule: {
            name: 'handle-cancellation',
            condition: { equals: { field: 'taskType', value: 'handle-cancellation' } },
            messageTemplate: 'templates/handle-cancellation.md',
          },
        },
      ],
    });

    expect(result.yaml).toContain('handle-cancellation');
    expect(result.config.routing['internal']?.rules.length).toBe(2);
    // Existing comment block above gmail-pubsub still there.
    expect(result.yaml).toContain('# Top-level Winston routing config.');
  });

  it('refuses rule.add when a rule of the same name already exists', () => {
    expect(() =>
      processEdits(FIXTURE_WITH_COMMENTS, {
        message: 'collision',
        description: '',
        edits: [
          {
            op: 'rule.add',
            provider: 'gmail-pubsub',
            rule: {
              name: 'triage-heather-inbox',
              condition: { all_of: [] },
              messageTemplate: 'templates/x.md',
            },
          },
        ],
      }),
    ).toThrow(/already exists/);
  });

  it('refuses rule.update for an unknown rule name', () => {
    expect(() =>
      processEdits(FIXTURE_WITH_COMMENTS, {
        message: 'missing target',
        description: '',
        edits: [
          {
            op: 'rule.update',
            provider: 'gmail-pubsub',
            ruleName: 'does-not-exist',
            changes: { messageTemplate: 'templates/x.md' },
          },
        ],
      }),
    ).toThrow(/not found/);
  });

  it('refuses rule.delete for an unknown rule name', () => {
    expect(() =>
      processEdits(FIXTURE_WITH_COMMENTS, {
        message: 'delete missing',
        description: '',
        edits: [{ op: 'rule.delete', provider: 'gmail-pubsub', ruleName: 'does-not-exist' }],
      }),
    ).toThrow(/not found/);
  });

  it('refuses any operation against an unknown provider', () => {
    expect(() =>
      processEdits(FIXTURE_WITH_COMMENTS, {
        message: 'unknown provider',
        description: '',
        edits: [
          {
            op: 'rule.update',
            provider: 'made-up',
            ruleName: 'triage-heather-inbox',
            changes: { messageTemplate: 'templates/x.md' },
          },
        ],
      }),
    ).toThrow(/not found under routing/);
  });

  it('rule.delete removes the rule (and its inline comments)', () => {
    const result = processEdits(FIXTURE_WITH_COMMENTS, {
      message: 'drop the chat rule',
      description: '',
      edits: [{ op: 'rule.delete', provider: 'gmail-pubsub', ruleName: 'email-chat-winston' }],
    });
    expect(result.yaml).not.toContain('email-chat-winston');
    expect(result.config.routing['gmail-pubsub']?.rules.length).toBe(1);
  });

  it('applies multiple edits in order — add + update + delete in one payload', () => {
    const result = processEdits(FIXTURE_WITH_COMMENTS, {
      message: 'batch edit',
      description: '',
      edits: [
        {
          op: 'rule.add',
          provider: 'internal',
          rule: {
            name: 'handle-onboarding',
            condition: { equals: { field: 'taskType', value: 'client-onboarding' } },
            messageTemplate: 'templates/handle-onboarding.md',
          },
        },
        {
          op: 'rule.update',
          provider: 'internal',
          ruleName: 'draft-response',
          changes: { messageTemplate: 'templates/draft-responses-v2.md' },
        },
        { op: 'rule.delete', provider: 'gmail-pubsub', ruleName: 'email-chat-winston' },
      ],
    });
    expect(result.config.routing['internal']?.rules.length).toBe(2);
    expect(result.config.routing['gmail-pubsub']?.rules.length).toBe(1);
    expect(result.yaml).toContain('templates/draft-responses-v2.md');
  });

  it('rejects an edit that produces a structurally invalid config (e.g. tools as non-array)', () => {
    expect(() =>
      processEdits(FIXTURE_WITH_COMMENTS, {
        message: 'broken edit',
        description: '',
        edits: [
          {
            op: 'rule.update',
            provider: 'gmail-pubsub',
            ruleName: 'triage-heather-inbox',
            changes: { tools: 'not-an-array' },
          },
        ],
      }),
    ).toThrow(/Post-edit config failed validation/);
  });

  it('Zod schema rejects payloads with zero edits', () => {
    expect(() => editPayloadSchema.parse({ message: 'x', description: '', edits: [] })).toThrow();
  });

  it('Zod schema rejects unknown op types', () => {
    expect(() =>
      editPayloadSchema.parse({
        message: 'x',
        edits: [{ op: 'rule.swap-positions', provider: 'a', ruleName: 'b' }],
      }),
    ).toThrow();
  });
});
