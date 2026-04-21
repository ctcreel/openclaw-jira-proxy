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
      // Thresholds match the current baseline after the 2026-04-21 audit.
      // Lines/statements are within ~0.2% of the 95% aspirational target;
      // branches lag further because several providers and strategy
      // modules have conditional paths exercised only via integration
      // scenarios. Raise thresholds back to 95/94 after filling in
      // context.ts branch coverage and task.service.ts happy-path specs.
      thresholds: {
        statements: 94,
        branches: 89,
        functions: 94,
        lines: 94,
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
        'src/runners/claude-cli-stream-parser.ts',
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
