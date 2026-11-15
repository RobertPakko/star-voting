// Redraws public/og-image.png, the 1200×630 card chat apps show under a
// shared link, from og-image.html beside this file. Run it after changing
// the logo's colours or the byline: node scripts/og-image.mjs
// Needs the Chromium the browser suite uses (npx playwright install chromium).
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const page = new URL('./og-image.html', import.meta.url)
const out = fileURLToPath(new URL('../public/og-image.png', import.meta.url))

const browser = await chromium.launch()
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await tab.goto(page.href)
await tab.screenshot({ path: out })
await browser.close()
