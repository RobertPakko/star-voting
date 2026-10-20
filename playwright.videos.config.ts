import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

/**
 * `npm run videos`: the same built app as the browser tests, recording the
 * Start page's two loops. See e2e/videos.capture.ts.
 */
export default defineConfig({
  ...base,
  testMatch: 'videos.capture.ts',
  retries: 0,
  fullyParallel: false,
  workers: 1,
  projects: [{ name: 'capture', use: { ...devices['Desktop Chrome'] } }],
})
