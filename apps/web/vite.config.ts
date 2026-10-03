import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // R-OFF-01: installable app; the application files are cached by a service worker.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'EpiSoft — Épicafé de Montjavoult',
        short_name: 'EpiSoft',
        lang: 'fr',
        start_url: '/caisse',
        display: 'standalone',
        theme_color: '#14532d',
        background_color: '#fbfaf5',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/docs/],
        runtimeCaching: [
          {
            // Product images are immutable (a new upload gets a new id).
            urlPattern: ({ url }) => url.pathname.startsWith('/api/v1/media/'),
            handler: 'CacheFirst',
            options: { cacheName: 'episoft-media', expiration: { maxEntries: 1000 } },
          },
        ],
      },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // Same origin in development as in production: the session cookie just works.
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
  },
});
