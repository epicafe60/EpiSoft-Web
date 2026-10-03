import { defineConfig } from 'tsup';

// One bundle for the server; workspace packages are inlined, npm dependencies stay external.
export default defineConfig({
  entry: ['src/server.ts', 'src/cli/invite.ts', 'src/cli/migrate.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@episoft\//],
});
