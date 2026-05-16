import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

import { createWorkspaceEditHandler } from '../../src/controllers/workspace-edit.controller';
import type { WorkspaceEditConfig } from '../../src/controllers/workspace-edit.controller';
import type { AgentConfig, ResolvedAgent } from '../../src/services/agent-loader.service';
import type {
  GitOps,
  ProposeEditArgs,
  ProposeEditResult,
} from '../../src/services/workspace-git.service';

const execFile = promisify(execFileCallback);

const FIXTURE_YAML = `# decision: triage by emailAddress.
routing:
  gmail-pubsub:
    rules:
      - name: triage
        # match Heather's inbox
        condition:
          equals:
            field: emailAddress
            value: heather@example.com
        messageTemplate: templates/triage.md

modelRules:
  gmail-pubsub: []
`;

const EMPTY_CONFIG: AgentConfig = { routing: {}, modelRules: {} };

const CONFIG: WorkspaceEditConfig = {
  baseBranch: 'main',
  authorEmail: 'bot@example.com',
  authorName: 'test-bot',
  branchNamePrefix: 'workspace-edit',
};

class FakeGitOps implements GitOps {
  calls: ProposeEditArgs[] = [];
  result: ProposeEditResult = {
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    branchName: '',
    headSha: 'deadbeefcafebabe1234',
  };
  failWith: string | null = null;

  async proposeEdit(args: ProposeEditArgs): Promise<ProposeEditResult> {
    this.calls.push(args);
    if (this.failWith !== null) {
      throw new Error(this.failWith);
    }
    return { ...this.result, branchName: args.branchName };
  }
}

async function makeAgentDir(): Promise<{ agentDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'workspace-edit-test-'));
  await execFile('git', ['-C', root, 'init', '--initial-branch=main', '--quiet']);
  await writeFile(join(root, 'clawndom.yaml'), FIXTURE_YAML);
  return {
    agentDir: root,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function mountApp(agents: readonly ResolvedAgent[], gitOps: GitOps): Express {
  const app = express();
  app.post(
    '/api/workspace/:agent/edit',
    express.json({ limit: '1mb' }),
    createWorkspaceEditHandler(agents, gitOps, CONFIG),
  );
  return app;
}

describe('workspace-edit controller', () => {
  let server: Server;
  let baseUrl: string;
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  async function start(agents: readonly ResolvedAgent[], gitOps: GitOps): Promise<void> {
    const app = mountApp(agents, gitOps);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  it('rejects an empty agent param with 400', async () => {
    await start([{ name: 'winston', dir: '/tmp/x', config: EMPTY_CONFIG }], new FakeGitOps());
    const handler = createWorkspaceEditHandler(
      [{ name: 'winston', dir: '/tmp/x', config: EMPTY_CONFIG }],
      new FakeGitOps(),
      CONFIG,
    );
    const statusCalls: number[] = [];
    let jsonBody: unknown;
    const responseMock = {
      status(code: number): typeof responseMock {
        statusCalls.push(code);
        return responseMock;
      },
      json(body: unknown): typeof responseMock {
        jsonBody = body;
        return responseMock;
      },
    };
    await handler(
      { params: { agent: '' } } as unknown as Parameters<typeof handler>[0],
      responseMock as unknown as Parameters<typeof handler>[1],
    );
    expect(statusCalls).toContain(400);
    expect(jsonBody).toBeDefined();
  });

  it('returns 404 when the agent is not loaded', async () => {
    await start([{ name: 'winston', dir: '/tmp/x', config: EMPTY_CONFIG }], new FakeGitOps());
    const response = await fetch(`${baseUrl}/api/workspace/nope/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x', edits: [] }),
    });
    expect(response.status).toBe(404);
  });

  it('returns 400 when the body is not a valid edit payload (empty edits)', async () => {
    const fixture = await makeAgentDir();
    cleanup = fixture.cleanup;
    await start(
      [{ name: 'winston', dir: fixture.agentDir, config: EMPTY_CONFIG }],
      new FakeGitOps(),
    );

    const response = await fetch(`${baseUrl}/api/workspace/winston/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x', edits: [] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid edit payload/);
  });

  it('returns 400 when an edit references an unknown rule (UI out of date with on-disk)', async () => {
    const fixture = await makeAgentDir();
    cleanup = fixture.cleanup;
    await start(
      [{ name: 'winston', dir: fixture.agentDir, config: EMPTY_CONFIG }],
      new FakeGitOps(),
    );

    const response = await fetch(`${baseUrl}/api/workspace/winston/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'attempt to edit missing rule',
        edits: [
          {
            op: 'rule.update',
            provider: 'gmail-pubsub',
            ruleName: 'does-not-exist',
            changes: { messageTemplate: 'templates/x.md' },
          },
        ],
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not found/);
  });

  it('happy path: applies edits, calls GitOps with the right shape, returns PR metadata', async () => {
    const fixture = await makeAgentDir();
    cleanup = fixture.cleanup;
    const gitOps = new FakeGitOps();
    await start([{ name: 'winston', dir: fixture.agentDir, config: EMPTY_CONFIG }], gitOps);

    const response = await fetch(`${baseUrl}/api/workspace/winston/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'swap triage template',
        description: 'Operator wants a new triage template variant.',
        edits: [
          {
            op: 'rule.update',
            provider: 'gmail-pubsub',
            ruleName: 'triage',
            changes: { messageTemplate: 'templates/triage-v2.md' },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      prUrl: string;
      prNumber: number;
      branchName: string;
      headSha: string;
    };
    expect(body.prNumber).toBe(42);
    expect(body.prUrl).toContain('/pull/42');
    expect(body.branchName.startsWith('workspace-edit/winston/')).toBe(true);

    expect(gitOps.calls.length).toBe(1);
    const call = gitOps.calls[0]!;
    expect(call.repoDir).toBe(fixture.agentDir);
    expect(call.filePath).toBe(join(fixture.agentDir, 'clawndom.yaml'));
    expect(call.baseBranch).toBe('main');
    expect(call.commitMessage).toBe('swap triage template');
    expect(call.authorEmail).toBe('bot@example.com');
    expect(call.authorName).toBe('test-bot');
    // YAML went through the AST applier — comment preserved, value swapped.
    expect(call.newContent).toContain('# decision: triage by emailAddress.');
    expect(call.newContent).toContain('templates/triage-v2.md');
    expect(call.newContent).not.toContain('templates/triage.md\n');
    // PR body lists the operations and the operator's description.
    expect(call.prBody).toContain('Operator wants a new triage template variant.');
    expect(call.prBody).toContain('rule.update');
    expect(call.prBody).toContain('gmail-pubsub/triage');
  });

  it('propagates GitOps failures as 500 with the underlying message', async () => {
    const fixture = await makeAgentDir();
    cleanup = fixture.cleanup;
    const gitOps = new FakeGitOps();
    gitOps.failWith = 'gh pr create failed: remote rejected';
    await start([{ name: 'winston', dir: fixture.agentDir, config: EMPTY_CONFIG }], gitOps);

    const response = await fetch(`${baseUrl}/api/workspace/winston/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'something',
        edits: [
          {
            op: 'rule.update',
            provider: 'gmail-pubsub',
            ruleName: 'triage',
            changes: { messageTemplate: 'templates/x.md' },
          },
        ],
      }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/gh pr create failed/);
  });

  it('reads the actual on-disk YAML, not the in-memory config snapshot', async () => {
    // Boot-time config might be stale relative to disk. We expect the
    // controller to re-read the file before editing so concurrent
    // hand-edits aren't silently overwritten.
    const fixture = await makeAgentDir();
    cleanup = fixture.cleanup;
    // Overwrite with a different on-disk version.
    const drifted = FIXTURE_YAML.replace('templates/triage.md', 'templates/triage-drifted.md');
    await writeFile(join(fixture.agentDir, 'clawndom.yaml'), drifted);

    const gitOps = new FakeGitOps();
    await start([{ name: 'winston', dir: fixture.agentDir, config: EMPTY_CONFIG }], gitOps);

    const response = await fetch(`${baseUrl}/api/workspace/winston/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'edit',
        edits: [
          {
            op: 'rule.update',
            provider: 'gmail-pubsub',
            ruleName: 'triage',
            changes: { tools: [{ 'module.python': 'agency_tools.google.gmail_label' }] },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(gitOps.calls[0]!.newContent).toContain('templates/triage-drifted.md');
  });
});
