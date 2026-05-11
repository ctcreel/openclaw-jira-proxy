import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateToolSignature } from '../../../src/services/tools/validate';
import type { ToolDescriptor } from '../../../src/services/tools/descriptor';

describe('validateToolSignature (bash)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-validate-bash-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeBashDescriptor(
    args: ToolDescriptor['args'],
    requires: readonly string[],
  ): ToolDescriptor {
    return {
      kind: 'bash',
      directory: workDir,
      reference: 'pkg.tool',
      name: 'tool',
      description: 'test',
      args,
      requires,
    };
  }

  it('accepts a bash script whose header matches the YAML', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
# Args: ARG_CHANNEL, ARG_TEXT
# Optional: ARG_TEXT
# Requires-Env: SLACK_BOT_TOKEN
set -euo pipefail
`,
    );
    const descriptor = makeBashDescriptor(
      {
        channel: { type: 'string', description: 'c' },
        text: { type: 'string', description: 't', optional: true },
      },
      ['slack_bot_token'],
    );
    await expect(validateToolSignature(descriptor)).resolves.toBeUndefined();
  });

  it('rejects a bash script missing an arg the YAML declares', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
# Args: ARG_CHANNEL
set -euo pipefail
`,
    );
    const descriptor = makeBashDescriptor(
      { channel: { type: 'string', description: 'c' }, text: { type: 'string', description: 't' } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/omits ARG_TEXT/);
  });

  it('rejects when the optional list disagrees with YAML', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
# Args: ARG_CHANNEL
# Optional: ARG_CHANNEL
set -euo pipefail
`,
    );
    const descriptor = makeBashDescriptor(
      { channel: { type: 'string', description: 'c' } }, // not marked optional in YAML
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/Optional/);
  });

  it('rejects when bash declares an arg the YAML does not', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
# Args: ARG_CHANNEL, ARG_EXTRA
set -euo pipefail
`,
    );
    const descriptor = makeBashDescriptor({ channel: { type: 'string', description: 'c' } }, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/no such arg/);
  });

  it('rejects when bash header omits a required credential', async () => {
    await writeFile(
      join(workDir, 'impl.sh'),
      `#!/usr/bin/env bash
# Args: ARG_CHANNEL
set -euo pipefail
`,
    );
    const descriptor = makeBashDescriptor({ channel: { type: 'string', description: 'c' } }, [
      'api_token',
    ]);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/omits API_TOKEN/);
  });
});

describe('validateToolSignature (python)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-validate-py-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makePyDescriptor(
    args: ToolDescriptor['args'],
    requires: readonly string[],
  ): ToolDescriptor {
    return {
      kind: 'python',
      directory: workDir,
      reference: 'pkg.tool',
      name: 'tool',
      description: 'test',
      args,
      requires,
    };
  }

  it('accepts a helper whose signature matches the YAML', async () => {
    await writeFile(
      join(workDir, 'impl.py'),
      `def invoke(*, channel, text, thread_ts=None, bot_token):
    return {"ok": True}
`,
    );
    const descriptor = makePyDescriptor(
      {
        channel: { type: 'string', description: 'c' },
        text: { type: 'string', description: 't' },
        thread_ts: { type: 'string', description: 'tt', optional: true },
      },
      ['bot_token'],
    );
    await expect(validateToolSignature(descriptor)).resolves.toBeUndefined();
  });

  it('rejects a helper missing a YAML-declared arg', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, channel):\n    return {}\n`);
    const descriptor = makePyDescriptor(
      { channel: { type: 'string', description: 'c' }, text: { type: 'string', description: 't' } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/no such kwarg/);
  });

  it('rejects optional-in-YAML but no-default-in-signature', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, foo):\n    return {}\n`);
    const descriptor = makePyDescriptor(
      { foo: { type: 'string', description: 'f', optional: true } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(
      /optional in tool\.yaml but invoke\(\) has no signature default/,
    );
  });

  it('rejects required-in-YAML but has-default-in-signature (silent optional)', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, foo="default"):\n    return {}\n`);
    const descriptor = makePyDescriptor({ foo: { type: 'string', description: 'f' } }, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/silent optional/);
  });

  it('rejects extra kwargs in the signature not in args or requires', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(*, channel, mystery):\n    return {}\n`);
    const descriptor = makePyDescriptor({ channel: { type: 'string', description: 'c' } }, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/extra kwarg 'mystery'/);
  });

  it('rejects positional args in invoke()', async () => {
    await writeFile(join(workDir, 'impl.py'), `def invoke(channel, text):\n    return {}\n`);
    const descriptor = makePyDescriptor(
      { channel: { type: 'string', description: 'c' }, text: { type: 'string', description: 't' } },
      [],
    );
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/keyword-only/);
  });

  it('rejects when impl.py has no invoke function', async () => {
    await writeFile(join(workDir, 'impl.py'), `def other():\n    pass\n`);
    const descriptor = makePyDescriptor({}, []);
    await expect(validateToolSignature(descriptor)).rejects.toThrow(/missing a top-level 'invoke'/);
  });
});
