import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateToolSignature } from '../../../src/services/tools/validate';
import type { SecretSpec, ToolDescriptor } from '../../../src/services/tools/descriptor';

describe('validateToolSignature', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-validate-py-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function secret(canonical: string, ...aliases: string[]): SecretSpec {
    return { canonical, aliases: aliases.length > 0 ? aliases : [canonical.toUpperCase()] };
  }

  function makeDescriptor(
    args: ToolDescriptor['args'],
    secrets: readonly SecretSpec[],
  ): ToolDescriptor {
    return {
      directory: workDir,
      reference: 'pkg.tool',
      name: 'tool',
      description: 'test',
      args,
      secrets,
    };
  }

  it('accepts a helper whose signature matches the YAML', async () => {
    await writeFile(
      join(workDir, 'impl.py'),
      `def invoke(*, channel, text, thread_ts=None, bot_token):
    return {"ok": True}
`,
    );
    const descriptor = makeDescriptor(
      {
        channel: { type: 'string', description: 'c' },
        text: { type: 'string', description: 't' },
        thread_ts: { type: 'string', description: 'tt', optional: true },
      },
      [secret('bot_token')],
    );
    await expect(validateToolSignature(descriptor)).resolves.toBeUndefined();
  });

  it('rejects a helper missing a YAML-declared arg', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, channel):\n    return {}\n`);
    const descriptor = makeDescriptor(
      { channel: { type: 'string', description: 'c' }, text: { type: 'string', description: 't' } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/no such kwarg/);
  });

  it('rejects optional-in-YAML but no-default-in-signature', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, foo):\n    return {}\n`);
    const descriptor = makeDescriptor(
      { foo: { type: 'string', description: 'f', optional: true } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(
      /optional in tool\.yaml but invoke\(\) has no signature default/,
    );
  });

  it('rejects required-in-YAML but has-default-in-signature (silent optional)', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, foo="default"):\n    return {}\n`);
    const descriptor = makeDescriptor({ foo: { type: 'string', description: 'f' } }, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/silent optional/);
  });

  it('rejects a secret kwarg in invoke() that has a signature default', async () => {
    await writeFile(
      join(workDir, 'impl.py'),
      `def invoke(*, bot_token="default"):\n    return {}\n`,
    );
    const descriptor = makeDescriptor({}, [secret('bot_token')]);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/no default allowed/);
  });

  it('rejects extra kwargs in the signature not in args or secrets', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, channel, mystery):\n    return {}\n`);
    const descriptor = makeDescriptor({ channel: { type: 'string', description: 'c' } }, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/extra kwarg 'mystery'/);
  });

  it('rejects positional args in invoke()', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(channel, text):\n    return {}\n`);
    const descriptor = makeDescriptor(
      { channel: { type: 'string', description: 'c' }, text: { type: 'string', description: 't' } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/keyword-only/);
  });

  it('rejects when impl.py has no invoke function', async () => {
    await writeFile(join(workDir, 'impl.py'), `def other():\n    pass\n`);
    const descriptor = makeDescriptor({}, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/missing a top-level 'invoke'/);
  });
});
