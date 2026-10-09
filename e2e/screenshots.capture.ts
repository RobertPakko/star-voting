import { test, type Page } from '@playwright/test'

/**
 * The pictures the web app manifest offers an install dialog: `npm run
 * screenshots` writes them to public/screenshots/, and they are committed.
 *
 * Taken of the About page's sample poll, which is answered from a file and
 * needs no database, so they can be taken again by anybody, any time the
 * pages they show change shape. Light scheme, no motion, and the phone shots
 * at a phone's pixel density, since that is what an install sheet on a phone
 * is drawn at.
 */
const OUT = 'public/screenshots'

test.use({
  serviceWorkers: 'block',
  colorScheme: 'light',
  contextOptions: { reducedMotion: 'reduce' },
})

async function open(page: Page, path: string) {
  await page.goto(path)
  await page.getByRole('heading', { level: 1 }).waitFor()
  // The results' bars and the runoff's half pie, drawn in.
  await page.waitForTimeout(1200)
}

async function scoreSome(page: Page) {
  await page.getByLabel('Your name').fill('Sam')
  const scores = [5, 3, 4, 1, 4]
  const groups = page.getByRole('radiogroup')
  for (let i = 0; i < scores.length; i++) {
    const stars = scores[i]
    await groups
      .nth(i)
      .getByRole('radio', { name: `${stars} ${stars === 1 ? 'star' : 'stars'}`, exact: true })
      .click()
  }
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test('ballot', async ({ page }) => {
    await open(page, '#/polls/sample-dinner')
    await scoreSome(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `${OUT}/phone-ballot.png` })
  })

  test('calendar', async ({ page }) => {
    await open(page, '#/polls/sample-when')
    await page.getByLabel('Your name').fill('Sam')
    // Friday evening whole, at the brush's default of 5; then the 3 brush
    // over Saturday, so the picture shows the ramp rather than one colour.
    await page.getByRole('button', { name: /Fill the whole day 2026-02-20/ }).click()
    await page.getByText('3', { exact: true }).click()
    await page.getByRole('button', { name: /Fill the whole day 2026-02-21/ }).click()
    // The calendar at the top of the screen (under the 60px header), with the
    // line that says where the poll is held above it.
    await page.getByText(/All times are/).evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76)
    })
    await page.screenshot({ path: `${OUT}/phone-calendar.png` })
  })

  test('results', async ({ page }) => {
    await open(page, '#/polls/sample-result-dinner')
    await page.screenshot({ path: `${OUT}/phone-results.png` })
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

  test('ballot', async ({ page }) => {
    await open(page, '#/polls/sample-dinner')
    await scoreSome(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `${OUT}/desktop-ballot.png` })
  })

  test('results', async ({ page }) => {
    await open(page, '#/polls/sample-result-dinner')
    await page.screenshot({ path: `${OUT}/desktop-results.png` })
  })
})
