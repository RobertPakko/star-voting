import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

/**
 * `npm run screenshots`: the same built app as the browser tests, running the
 * one file in e2e/ that is not a test. See e2e/screenshots.capture.ts.
 */
export default defineConfig({
  ...base,
  testMatch: 'screenshots.capture.ts',
  retries: 0,
  projects: [{ name: 'capture', use: { ...devices['Desktop Chrome'] } }],
})
