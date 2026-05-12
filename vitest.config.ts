import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Threshold ratchet (SPE-2078 followups):
      //   statements 87 → 95
      //   branches   87 → 88   (see note below)
      //   functions  93 → 95
      //   lines      87 → 95
      //
      // Why branches lands at 88, not 95: the remaining gap is in files
      // whose uncovered branches are documented-unreachable defensive
      // narrowing for `noUncheckedIndexedAccess` (e.g. `if (byteAt ===
      // undefined) throw 'unreachable'` in embedding/null.ts, the
      // `multiplier === undefined` branch in lib/duration.ts, the
      // `error instanceof Error ? ... : String(error)` ternaries on
      // `try { exec }` blocks). Forcing the 95% branch number would
      // require either fake tests of unreachable code or deleting the
      // TypeScript narrows — both make the code worse, not better.
      // Reachable error paths are covered.
      //
      // To genuinely push branches higher: remove `noUncheckedIndexedAccess`
      // from tsconfig (drops a real safety net), or refactor to runtime
      // shape-validation primitives (large change, separate scope).
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 95,
        lines: 95,
      },
      exclude: [
        'tests/**',
        'scripts/**',
        'infra/**',
        'vitest.config.ts',
        'src/types.ts',
        'src/types/**',
        'src/server.ts',
        'src/services/worker.service.ts',
        'src/services/worker-failure-handler.ts',
        'src/services/task-worker.service.ts',
        // Subprocess + Redis orchestration; covered by 11 dedicated unit
        // tests in tests/services/session-pool.service.test.ts (mocking
        // node:child_process and ioredis). Excluded from line/branch
        // counting for the same reason worker.service.ts is — most of
        // the file is glue that's exercised end-to-end at integration
        // time, not unit-line.
        'src/services/session-pool.service.ts',
        'src/runners/claude-cli-stream-parser.ts',
        // Session-aware claude-cli orchestration — same justification
        // as session-pool.service.ts above: subprocess + SessionPool
        // integration exercised end-to-end at integration time (Slack
        // chat in production), not at unit-line. The SessionPool
        // class itself has 11 dedicated unit tests; this file is the
        // thin "deliver one turn" adapter on top.
        'src/runners/claude-cli-session-mode.ts',
        // SPE-2078 tool surface (executor.ts, mcp-bridge.ts, resolve.ts,
        // load-for-run.ts, version.service.ts) was previously excluded
        // here on a YAGNI-conservative basis. Coverage is now demonstrably
        // high enough that they belong in the gate — rolled back in the
        // SPE-2078 followups (see #20 in the change log).
        'src/lib/logging/adapters/**',
        'src/lib/observability/**',
        'src/lib/exceptions/handlers.ts',
        'src/lib/exceptions/server-errors.ts',
        'src/lib/logging/context.ts',
        'src/lib/utils/index.ts',
        'src/middleware/validate.ts',
        'src/lib/utils/cache.ts',
        'src/lib/utils/retry.ts',
        'src/lib/logging/logger.ts',
        'src/lib/logging/config.ts',
        'src/lib/exceptions/client-errors.ts',
        'src/lib/exceptions/base.ts',
        'src/middleware/request-logger.ts',
        'src/middleware/error-handler.ts',
        'src/controllers/health.controller.ts',
        'src/services/health.service.ts',
        'src/config.ts',
        'tsup.config.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
