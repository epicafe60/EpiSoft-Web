import { defineConfig, devices } from '@playwright/test';

export const WEB_PORT = 5174;
export const API_PORT = 3100;
/** Production build with the service worker (offline reload test). */
export const PREVIEW_PORT = 5175;

// The whole stack (PostgreSQL, API, web app) is started by global-setup.ts.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
