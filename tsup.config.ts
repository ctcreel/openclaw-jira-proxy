import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  external: ['openclaw'],
  // SPE-2070: `render-tool-block.ts` resolves `tools-introspect.py` via
  // `import.meta.url` so the same file path works in dev (tsx) and prod
  // (bundled `dist/server.js`). The bundler doesn't copy non-TS assets,
  // so we copy the script alongside the bundle here. Keep this in sync
  // if more sibling Python scripts ever land under `lib/template/`.
  async onSuccess() {
    const dest = 'dist/tools-introspect.py';
    await mkdir(dirname(dest), { recursive: true });
    await copyFile('src/lib/template/tools-introspect.py', dest);
  },
});
