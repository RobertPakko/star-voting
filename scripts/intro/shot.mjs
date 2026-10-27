// Goes to an address in the capture browser and screenshots it (for looking).
import { attach, SITE } from './lib.mjs'
const { page } = await attach()
// The route without its '#/', which Git Bash would rewrite as a path.
if (process.argv[2] !== undefined) await page.goto(SITE + '#/' + process.argv[2])
await page.waitForTimeout(2500)
await page.screenshot({ path: process.argv[3], fullPage: process.argv[4] === 'full' })
process.exit(0)
