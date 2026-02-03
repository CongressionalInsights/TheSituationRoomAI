import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'scripts/test',
  testMatch: /ui\.spec\.mjs$/,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60 * 1000
  }
});
