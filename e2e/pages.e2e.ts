import { test, expect, expectAccessible, setColorScheme } from './fixtures'

/**
 * Every page a reader can reach without signing in, checked for
 * accessibility in both colour schemes, and the pieces of each that work
 * without a database.
 */
const PAGES = [
  { path: '#/', title: 'Sign in', name: 'the sign-in screen' },
  { path: '#/about', title: 'About STAR', name: 'About' },
  { path: '#/app', title: 'Install the app', name: 'the install guide' },
  { path: '#/intro', title: 'STAR Voting', name: 'the intro' },
  { path: '#/polls/sample-dinner', title: 'Movie night', name: 'a ballot' },
  { path: '#/polls/sample-when', title: 'Movie night', name: 'a calendar ballot' },
  { path: '#/polls/sample-result-dinner', title: 'Movie night', name: 'a result' },
  { path: '#/polls/sample-result-when', title: 'Movie night', name: 'a calendar result' },
]

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    for (const { path, name } of PAGES) {
      test(`${name} is accessible`, async ({ page }) => {
        await setColorScheme(page, scheme)
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1 })).toBeAttached()
        // Past every entrance: a fade caught halfway is a colour axe would
        // measure as a contrast failure that no reader ever sees.
        await page.waitForTimeout(800)
        await expectAccessible(page, name)
      })
    }

    test('the settings menu is accessible open', async ({ page }) => {
      await setColorScheme(page, scheme)
      await page.goto('#/about')
      await page.getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('link', { name: 'View intro' })).toBeVisible()
      await page.waitForTimeout(300)
      await expectAccessible(page, 'the settings menu')
    })
  })
}

test.describe('page titles', () => {
  for (const { path, title, name } of PAGES) {
    test(`${name} names its tab`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveTitle(title)
    })
  }

  test('a change of page is announced, and its title with it', async ({ page }) => {
    await page.goto('#/about')
    await expect(page).toHaveTitle('About STAR')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('link', { name: 'App installation' }).click()
    await expect(page).toHaveTitle('Install the app')
    await expect(page.locator('[data-announcer="polite"]')).toHaveText('Install the app')
  })
})

test.describe('the sign-in screen', () => {
  test('offers a link or a code, and a way past it', async ({ page }) => {
    await page.goto('#/')
    await expect(page.getByRole('heading', { name: 'STAR Voting', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible()
    await page.getByText('Email a code').click()
    await expect(page.getByRole('button', { name: 'Send sign-in code' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue without an account' })).toBeVisible()
  })
})

test.describe('About', () => {
  test('its tabs switch, and its sample links open the sample', async ({ page }) => {
    await page.goto('#/about')
    await page.getByRole('tab', { name: 'Site features' }).click()
    await expect(page.getByRole('tab', { name: 'Site features' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expectAccessible(page, 'the features tab')
    await page
      .getByRole('link', { name: /sample/i })
      .first()
      .click()
    await expect(page).toHaveURL(/#\/polls\/sample-/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Movie night')
  })
})

test.describe('the intro', () => {
  // On its last frame from the start, buttons and all.
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('shares through the device share sheet, the link under the sentence', async ({ page }) => {
    await page.addInitScript(() => {
      const shared: ShareData[] = []
      ;(window as unknown as { shared: ShareData[] }).shared = shared
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          shared.push(data)
        },
      })
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    })
    await page.goto('#/intro')
    await page.getByRole('button', { name: 'Share this intro' }).click()
    const shared = await page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared)
    expect(shared).toHaveLength(1)
    expect(shared[0].url).toBeUndefined()
    expect(shared[0].text).toMatch(
      /^Check out STAR Voting!\n\nhttp:\/\/localhost:\d+\/star-voting\/#\/intro$/,
    )
  })

  test('copies the link where there is no share sheet', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    })
    await page.goto('#/intro')
    await page.getByRole('button', { name: 'Share this intro' }).click()
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible()
    await expect(page.locator('[data-announcer="polite"]')).toHaveText('Link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toMatch(/^http:\/\/localhost:\d+\/star-voting\/#\/intro$/)
  })

  test('ends on its three ways on', async ({ page }) => {
    await page.goto('#/intro')
    await expect(page.getByRole('link', { name: 'Learn more about STAR' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Make your own poll' })).toBeVisible()
    await page.getByRole('link', { name: 'Learn more about STAR' }).click()
    await expect(page).toHaveURL(/#\/about$/)
  })
})

test.describe('the web app manifest', () => {
  test('names the app, its shortcuts and screenshots, and every file it names exists', async ({
    page,
    request,
  }) => {
    await page.goto('#/about')
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href).toBeTruthy()
    const manifestUrl = new URL(href!, page.url()).href
    const manifest = await (await request.get(manifestUrl)).json()

    expect(manifest.id).toBe('/star-voting/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.launch_handler.client_mode).toContain('focus-existing')
    expect(manifest.shortcuts.map((s: { name: string }) => s.name)).toEqual([
      'New poll',
      'Your polls',
    ])
    // Narrow for a phone's install sheet and wide for a desktop's: each is
    // only shown where there is at least one of its kind.
    const forms = manifest.screenshots.map((s: { form_factor: string }) => s.form_factor)
    expect(forms).toContain('narrow')
    expect(forms).toContain('wide')

    const files = [
      ...manifest.icons.map((i: { src: string; sizes: string }) => i),
      ...manifest.screenshots.map((s: { src: string; sizes: string }) => s),
    ]
    for (const { src, sizes } of files) {
      const response = await request.get(new URL(src, manifestUrl).href)
      expect(response.status(), src).toBe(200)
      expect(response.headers()['content-type'], src).toContain('image/png')
      // The size the manifest claims is the size the file is: a mismatch is
      // a screenshot Chrome silently refuses to show.
      const [width, height] = sizes.split('x').map(Number)
      const png = await response.body()
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], src).toEqual([width, height])
    }
  })
})
