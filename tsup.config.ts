import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/audit/cli.ts', 'src/graph/cli.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  external: ['openclaw'],
});
