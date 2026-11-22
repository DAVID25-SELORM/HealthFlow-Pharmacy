import { defineConfig, devices } from '@playwright/test'

// Browser layout guard. These tests open the real built app in a real browser at
// phone, tablet and computer sizes against a fake backend (see e2e/support).
// They never touch production data.
//
// Run locally:  npm run test:e2e
// If your machine already has a Chromium but not the one this Playwright version
// expects, point PW_CHROMIUM_PATH at its chrome executable.

const PORT = 4173
const executablePath = process.env.PW_CHROMIUM_PATH || undefined
const launchOptions = executablePath ? { executablePath } : {}

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 780 }, launchOptions } },
    { name: 'small-phone', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 640 }, launchOptions } },
    { name: 'tablet', use: { viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: 'computer', use: { viewport: { width: 1366, height: 768 } } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_SUPABASE_URL: 'https://guard-test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'guard-test-key',
      VITE_HEALTHFLOW_CLOUD_URL: '',
      VITE_APP_URL: `http://127.0.0.1:${PORT}`,
    },
  },
})
