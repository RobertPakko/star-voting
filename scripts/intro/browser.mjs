// Opens the intro recording's browser: Edge (Playwright's own Chromium is
// blocked on some Windows machines), headed, on a
// profile of its own (.capture-profile/, gitignored, holding the test
// account's session), with a debugging port the capture scripts attach to.
// Leave it running while recording; sign in once inside it.
import { chromium } from '@playwright/test'
const context = await chromium.launchPersistentContext('.capture-profile', {
  channel: 'msedge',
  headless: false,
  viewport: null,
  serviceWorkers: 'block',
  args: ['--remote-debugging-port=9333', '--window-size=1400,1000'],
})
const page = context.pages()[0] ?? (await context.newPage())
await page.goto('https://choicelab.app/#/sign-in')
console.log('ready')
context.on('close', () => process.exit(0))
