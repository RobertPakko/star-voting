import { test, expect, expectAccessible, setColorScheme } from './fixtures'

/**
 * Every page a reader can reach without signing in, checked for
 * accessibility in both colour schemes, and the pieces of each that work
 * without a database.
 */
const PAGES: { path: string; title: string; name: string }[] = [
  { path: '#/', title: 'ChoiceLab', name: 'the home page' },
  { path: '#/sign-in', title: 'Sign in', name: 'the sign-in screen' },
  { path: '#/star', title: 'What is STAR?', name: 'What is STAR?' },
  { path: '#/why-star', title: 'Why use STAR?', name: 'Why use STAR?' },
  { path: '#/features', title: 'App features', name: 'App features' },
  { path: '#/app', title: 'Install the app', name: 'the install guide' },
  { path: '#/intro', title: 'ChoiceLab', name: 'the intro' },
  { path: '#/donate', title: 'Donate', name: 'the donate page' },
  { path: '#/contact', title: 'Contact', name: 'the contact page' },
  { path: '#/sample-dinner', title: 'Movie night', name: 'a ballot' },
  { path: '#/sample-when', title: 'Movie night', name: 'a calendar ballot' },
  { path: '#/sample-result-dinner', title: 'Movie night', name: 'a result' },
  { path: '#/sample-result-when', title: 'Movie night', name: 'a calendar result' },
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
      await page.goto('#/')
      await page.getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
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
    await page.goto('#/')
    await expect(page).toHaveTitle('ChoiceLab')
    await page.getByRole('link', { name: /^App features/ }).click()
    await expect(page).toHaveTitle('App features')
    await expect(page.locator('[data-announcer="polite"]')).toHaveText('App features')
  })
})

test.describe('the home page', () => {
  test('has a tile for every page, two to a row', async ({ page }) => {
    await page.goto('#/')
    await expect(
      page.getByRole('heading', { name: 'Better group decisions', level: 1 }),
    ).toBeVisible()
    const tiles = page.getByRole('main').locator('a, button')
    await expect(tiles).toHaveCount(12)
    const tops = await tiles.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    )
    for (let i = 0; i < tops.length; i += 2) expect(tops[i + 1]).toBe(tops[i])
    expect(tops[2]).toBeGreaterThan(tops[0])
    // Not installed here, so the slot offers installing rather than the code.
    await expect(page.getByRole('link', { name: /^App code/ })).toHaveCount(0)
    await page.getByRole('link', { name: /^Install app/ }).click()
    await expect(page).toHaveTitle('Install the app')
  })

  test('is where the logo goes, and every page leads back to it', async ({ page }) => {
    for (const path of [
      '#/star',
      '#/why-star',
      '#/features',
      '#/contact',
      '#/donate',
      '#/app',
      '#/sample-dinner',
      '#/sign-in',
      '#/no-such-page',
    ]) {
      await page.goto(path)
      await page.getByRole('link', { name: 'Back to homepage' }).click()
      await expect(page, path).toHaveURL(/#\/$/)
    }
    await page.goto('#/donate')
    await page
      .getByRole('banner')
      .getByRole('link', { name: /ChoiceLab/ })
      .click()
    await expect(page).toHaveURL(/#\/$/)
  })

  test('opens the page a tile leads to at its top', async ({ page }) => {
    // A long page, its code already fetched, so nothing short stands in for it
    // while it loads (which would clamp the scroll and hide the fault).
    await page.goto('#/why-star')
    await expect(page).toHaveTitle('Why use STAR?')
    await page.getByRole('link', { name: 'Back to homepage' }).click()
    const tile = page.getByRole('link', { name: /^Why STAR/ })
    await tile.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await tile.click()
    await expect(page).toHaveTitle('Why use STAR?')
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('opens the sample poll and its result', async ({ page }) => {
    await page.goto('#/')
    await page.getByRole('link', { name: /^Example poll/ }).click()
    await expect(page).toHaveURL(/#\/sample-dinner$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Movie night')
    await page.goBack()
    await page.getByRole('link', { name: /^Example result/ }).click()
    await expect(page).toHaveURL(/#\/sample-result-dinner$/)
  })

  test('holds its ballot still under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('#/')
    const frame = () => page.locator('main [aria-hidden]').first().innerHTML()
    const first = await frame()
    await page.waitForTimeout(1000)
    expect(await frame()).toBe(first)
  })

  test('leaves the settings menu to settings', async ({ page }) => {
    await page.goto('#/')
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('link')).toHaveCount(0)
  })
})

test.describe('the sign-in screen', () => {
  test('offers a link or a code, and a way past it', async ({ page }) => {
    await page.goto('#/sign-in')
    await expect(page.getByRole('heading', { name: 'ChoiceLab', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible()
    await page.getByText('Email a code').click()
    await expect(page.getByRole('button', { name: 'Send sign-in code' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue without an account' })).toBeVisible()
  })

  test('stands in front of the poll list and the create form', async ({ page }) => {
    await page.goto('#/polls')
    await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible()
    await page.goto('#/new')
    await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible()
    await page.goto('#/polls/new')
    await expect(page).toHaveURL(/#\/new$/)
    await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible()
  })
})

test.describe('the donate page', () => {
  test('is reached from the home page, and gives through Every.org', async ({ page }) => {
    await page.goto('#/')
    await page.getByRole('link', { name: /^Donate/ }).click()
    await expect(page).toHaveTitle('Donate')
    await expect(page.getByRole('link', { name: 'Donate', exact: true })).toHaveAttribute(
      'href',
      /^https:\/\/www\.every\.org\/khan-academy(\/f\/[^#]+)?#donate$/,
    )
  })
})

test.describe('the contact page', () => {
  test('is reached from the home page', async ({ page }) => {
    await page.goto('#/')
    await page.getByRole('link', { name: /^Contact/ }).click()
    await expect(page).toHaveTitle('Contact')
  })

  test('marks what is missing on the press, and sends nothing', async ({ page }) => {
    await page.goto('#/contact')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText('Enter an email address so I can reply')).toBeVisible()
    await expect(page.getByText('Write a message to send')).toBeVisible()
    await expect(page.getByLabel('Your email address')).toBeFocused()
    await page.getByLabel('Your email address').fill('reader@example.com')
    await expect(page.getByText('Enter an email address so I can reply')).toHaveCount(0)
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
    expect(shared[0].text).toMatch(/^Check out ChoiceLab!\n\nhttp:\/\/localhost:\d+\/#\/intro$/)
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
    expect(copied).toMatch(/^http:\/\/localhost:\d+\/#\/intro$/)
  })

  test('ends on its three ways on', async ({ page }) => {
    await page.goto('#/intro')
    await expect(page.getByRole('link', { name: 'Back to homepage' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Make your own poll' })).toBeVisible()
    await page.getByRole('link', { name: 'Back to homepage' }).click()
    await expect(page).toHaveURL(/#\/$/)
  })

  test('fetches no footage when it opens on its last frame', async ({ page }) => {
    const fetched: string[] = []
    page.on('request', (r) => {
      if (/\/intro\/.*\.mp4/.test(r.url())) fetched.push(r.url())
    })
    await page.goto('#/intro')
    await expect(page.getByRole('link', { name: 'Back to homepage' })).toBeVisible()
    await page.waitForTimeout(500)
    expect(fetched).toEqual([])
  })

  test('steps through the features by hand, and holds still', async ({ page }) => {
    await page.goto('#/intro')
    const features = page.getByRole('region', { name: 'What else ChoiceLab does' })
    await expect(features.getByText('Free', { exact: true })).toBeVisible()
    // Less motion asked for: no turning, so nothing to pause.
    await expect(features.getByRole('button', { name: /Pause|Play/ })).toHaveCount(0)
    await features.getByRole('button', { name: 'Next feature' }).click()
    await expect(features.getByText('Fast', { exact: true })).toBeVisible()
    await expect(features.getByText('Free', { exact: true })).toBeHidden()
    await features.getByRole('button', { name: 'Previous feature' }).click()
    await features.getByRole('button', { name: 'Previous feature' }).click()
    await expect(features.getByText('Fair', { exact: true })).toBeVisible()
    await expectAccessible(page, 'the features')
  })
})

test.describe('the web app manifest', () => {
  test('names the app, its shortcuts and screenshots, and every file it names exists', async ({
    page,
    request,
  }) => {
    await page.goto('#/')
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
      // A shortcut with no icon is drawn as a blank square on Android.
      ...manifest.shortcuts.flatMap((s: { icons: { src: string; sizes: string }[] }) => s.icons),
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
