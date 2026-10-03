import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // Same origin in development as in production: the session cookie just works.
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
  },
});
