import { defineConfig, devices } from '@playwright/test'

/**
 * The browser half of the test suite: the pages a reader can reach without a
 * backend, driven in Chromium and checked with axe. See "Tests" in AGENTS.md
 * for what that does and does not cover.
 *
 * It runs against the *built* app under `vite preview`, not the dev server,
 * because the build is what ships: the lazy chunks, the base path and the
 * stale-build listener only exist there.
 *
 * The Supabase address is a closed port. Nothing these pages draw needs the
 * database — the sample poll is answered from a file, and a reader with no
 * session reads nothing — so a request that does go out is a bug in the page,
 * and `e2e/fixtures.ts` fails the test on one.
 */
const PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/star-voting/`,
    trace: 'retain-on-failure',
    // The worker caches the shell, which a fresh context per test makes
    // harmless, but it also answers requests the tests would rather see go to
    // the server. Its own behaviour is not what these tests are about.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // A phone, because most voters are on one and the layout is different
    // there: the header wraps, the calendar scrolls, the intro is portrait.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/star-voting/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:9',
      VITE_SUPABASE_ANON_KEY: 'e2e-anon-key',
    },
  },
})
