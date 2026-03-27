import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
      exclude: [
        'tests/**',
        'scripts/**',
        'infra/**',
        'vitest.config.ts',
        'src/types.ts',
        'src/server.ts',
        'src/services/worker.service.ts',
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
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
