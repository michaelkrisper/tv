import { defineConfig, devices } from '@playwright/test';

// Läuft gegen den fertigen Build in dist/ (vorher `npm run build`).
const PORT = 8081;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}/`,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
