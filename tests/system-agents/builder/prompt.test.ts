import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

async function loadPrompt(): Promise<string> {
  return readFile('src/system-agents/builder/prompt.md', 'utf-8');
}

describe('Builder system prompt', () => {
  it("declares scope is the dispatching agent's directory only", async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/dispatching agent's directory/i);
    expect(prompt).toMatch(/\bpath\b/);
  });

  it('refuses out-of-scope: clawndom, sharedTools, other agents, other repos', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/clawndom/);
    expect(prompt).toMatch(/sharedTools/);
    expect(prompt).toMatch(/colocated agents'/i);
  });

  it('encodes the what-goes-where taxonomy with all six slots', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/Executable behavior/i);
    expect(prompt).toMatch(/Prompt text/i);
    expect(prompt).toMatch(/Persistent state/i);
    expect(prompt).toMatch(/HTTP entry points/i);
    expect(prompt).toMatch(/Authorization/i);
    expect(prompt).toMatch(/Business logic/i);
  });

  it('declares the four lifecycle states', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/`working`/);
    expect(prompt).toMatch(/`question_pending`/);
    expect(prompt).toMatch(/`testable`/);
    expect(prompt).toMatch(/`failed`/);
  });

  it('forbids silent failure', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/silent failure is forbidden/i);
  });

  it('encodes repo hygiene: fresh start (fetch + reset to configured base ref)', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/base ref/i);
    expect(prompt).toMatch(/fetch/i);
  });

  it('encodes repo hygiene: branch naming convention with default', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/branchNamingPattern|builder\/<kebab-case-summary>/);
    expect(prompt).toMatch(/Never push to `main` directly/i);
  });

  it('encodes repo hygiene: resume preserves prior commits, no force-push', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/force-push|force push/i);
    expect(prompt).toMatch(/preserve|prior commits/i);
  });

  it('encodes repo hygiene: run check-all before marking PR ready', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/make check-all|verification command/i);
    expect(prompt).toMatch(/before .*ready|gh pr ready/i);
  });

  it('encodes repo hygiene: no hook bypass', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/--no-verify/);
    expect(prompt).toMatch(/--no-gpg-sign/);
  });

  it('encodes repo hygiene: no secret or large-binary commits', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/credentials|secret/i);
    expect(prompt).toMatch(/binary|binaries/i);
    expect(prompt).toMatch(/\.gitignore/);
  });

  it('encodes repo hygiene: commit-message style', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/Conventional Commits|commit-message style/i);
  });

  it('encodes repo hygiene: cleanup after terminal state', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/delete the working branch|cleanup/i);
  });

  it('forbids direct user-facing channels', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/do not have Slack/i);
    expect(prompt).toMatch(/Gmail/);
    expect(prompt).toMatch(/dispatching agent's callback handler/i);
  });

  it('directs Builder to maintain the plan in a draft PR body rather than a committed file', async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/draft PR/i);
    expect(prompt).toMatch(/gh pr edit.*--body/);
    expect(prompt).toMatch(/gh pr view.*--json body/);
    expect(prompt).not.toMatch(/\.builder\/plan\.md/);
  });
});
