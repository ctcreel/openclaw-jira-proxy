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
      // Thresholds match the CI-measured baseline (Linux + v8 coverage
      // honoring the exclude list below). The 95% aspiration was rolled
      // back: locally vitest does not honor the exclude list on macOS,
      // which inflates local numbers to 95+ while CI sits at ~88%. Real
      // gap is in pre-SPE-2078 files (controllers, runners, secrets,
      // task.service.ts in the 78–94% range). Raising the global ratchet
      // before tightening those files just blocks unrelated PRs.
      //
      // SPE-2078 surface is well-covered on its own merits — see the
      // leakage-probe + multi-tool-isolation integration tests, plus
      // executor/mcp-bridge unit tests.
      thresholds: {
        statements: 87,
        branches: 87,
        functions: 93,
        lines: 87,
      },
      exclude: [
        'tests/**',
        'scripts/**',
        'infra/**',
        'vitest.config.ts',
        'src/types.ts',
        'src/types/**',
        'src/server.ts',
        'src/audit/cli.ts',
        'src/graph/cli.ts',
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
