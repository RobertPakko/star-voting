import { test, type CDPSession, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The two loops the Start page plays in its circles: `npm run videos` writes
 * them to public/start/, and they are committed.
 *
 * Recorded from the About page's sample poll, which is answered from a file
 * and needs no database, so they can be recorded again by anybody whenever
 * the ballot or the calendar changes shape. Frames come from Chromium's
 * screencast rather than Playwright's own video, which is encoded at a
 * bitrate that blurs text, and are put together by ffmpeg (on the PATH).
 *
 * Headless Chromium draws no pointer, so the page is given one: a fingertip
 * that follows the mouse and dips when pressed.
 */
const OUT = 'public/start'
const SIZE = 440
const SCALE = 2
const PX = 560

test.use({
  serviceWorkers: 'block',
  colorScheme: 'light',
  viewport: { width: SIZE, height: SIZE },
  deviceScaleFactor: SCALE,
})

const FINGER = `
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div')
    dot.style.cssText = 'position:fixed;left:-60px;top:-60px;width:30px;height:30px;margin:-15px 0 0 -15px;' +
      'border-radius:50%;background:rgba(30,30,40,.28);border:2px solid rgba(255,255,255,.9);' +
      'box-shadow:0 1px 6px rgba(0,0,0,.3);pointer-events:none;z-index:2147483647;transition:transform 120ms'
    document.documentElement.appendChild(dot)
    const style = document.createElement('style')
    style.textContent = '.mantine-AppShell-header,.mantine-Notifications-root{display:none!important}'
    document.head.appendChild(style)
    addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => { dot.style.transform = 'scale(.75)' }, true)
    addEventListener('mouseup', () => { dot.style.transform = '' }, true)
  })
`

/** Screencast frames, each with the moment it was drawn. */
class Recorder {
  frames: { data: Buffer; at: number }[] = []
  private cdp!: CDPSession
  private page: Page
  constructor(page: Page) {
    this.page = page
  }

  async start() {
    this.cdp ??= await this.page.context().newCDPSession(this.page)
    this.cdp.on('Page.screencastFrame', (f) => {
      this.frames.push({ data: Buffer.from(f.data, 'base64'), at: f.metadata.timestamp ?? 0 })
      void this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await this.resume()
  }

  /** Recording again after a pause, as though no time had passed. */
  async resume() {
    await this.cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  }
  private gaps: number[] = []

  async pause() {
    await this.cdp.send('Page.stopScreencast')
    this.gaps.push(this.frames.length)
  }

  /** Holds the last frame `ms` longer, then writes an mp4 and a poster. */
  async save(name: string, holdMs: number) {
    await this.cdp.send('Page.stopScreencast')
    const dir = mkdtempSync(join(tmpdir(), 'start-video-'))
    const lines: string[] = []
    this.frames.forEach((f, i) => {
      const file = join(dir, `${String(i).padStart(5, '0')}.png`)
      writeFileSync(file, f.data)
      const next = this.frames[i + 1]
      // A pause in the recording is a cut, not a wait: the frame before it is
      // shown for one frame's length rather than for however long it took.
      const cut = this.gaps.includes(i + 1)
      const d = next && !cut ? Math.max(next.at - f.at, 1 / 60) : cut ? 1 / 30 : holdMs / 1000
      lines.push(`file '${file.replaceAll('\\', '/')}'`, `duration ${d.toFixed(4)}`)
    })
    lines.push(lines[lines.length - 2])
    const list = join(dir, 'list.txt')
    writeFileSync(list, lines.join('\n'))
    mkdirSync(OUT, { recursive: true })
    const scale = `scale=${PX}:${PX}:flags=lanczos`
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `${scale},fps=30,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '26',
      '-movflags',
      '+faststart',
      '-an',
      `${OUT}/${name}.mp4`,
    ])
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      join(dir, `${String(this.frames.length - 1).padStart(5, '0')}.png`),
      '-vf',
      scale,
      '-q:v',
      '4',
      `${OUT}/${name}.jpg`,
    ])
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Glides the fingertip to the middle of a box and taps it. */
async function tap(page: Page, box: { x: number; y: number; width: number; height: number }) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 })
  await page.waitForTimeout(90)
  await page.mouse.down()
  await page.waitForTimeout(90)
  await page.mouse.up()
}

/**
 * The sample's first question is about food, and the loop it is recorded for
 * is "Choose a place", so its options are renamed to places on the way into
 * the page: the recorded data is a script chunk, and each name is replaced in
 * it before the app reads it. The tally is still the one `star_round()`
 * recorded; only the labels on it change, so the ballot, the runoff and the
 * winner all agree. Nothing is renamed outside this recording.
 */
const PLACES: Record<string, string> = {
  'What are we eating?': 'Where are we meeting?',
  'Two big pizzas': 'My house',
  'Taco bar': 'The park',
  'Everyone brings a dish': 'A bar',
  'Thai delivery': 'The beach',
  'Just snacks': 'A cafe',
}

async function renameToPlaces(page: Page) {
  await page.route(/\.js(\?.*)?$/, async (route) => {
    const response = await route.fetch()
    let body = await response.text()
    if (!body.includes('Two big pizzas')) return route.fulfill({ response })
    for (const [from, to] of Object.entries(PLACES)) body = body.replaceAll(from, to)
    await route.fulfill({ response, body })
  })
}

test('place', async ({ page }) => {
  await page.addInitScript(FINGER)
  await renameToPlaces(page)
  await page.goto('#/sample-dinner')
  await page.getByLabel('Your name').fill('Sam')
  const rows = page.getByRole('radiogroup', { name: /^Score for / })
  await rows.first().waitFor()
  // The options at the top of the frame, the name box above it.
  await rows.first().evaluate((el) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70)
  })
  await page.mouse.move(SIZE * 0.8, SIZE * 0.95)
  await page.waitForTimeout(300)

  const rec = new Recorder(page)
  await rec.start()
  await page.waitForTimeout(500)
  for (const [i, stars] of [5, 2, 4].entries()) {
    const star = rows.nth(i).getByRole('radio', { name: `${stars} stars`, exact: true })
    await tap(page, (await star.boundingBox())!)
    await page.waitForTimeout(260)
  }
  // Down to Submit, the way a thumb would.
  const submit = page.getByRole('button', { name: 'Submit vote' })
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 30)
    await page.waitForTimeout(22)
    const b = await submit.boundingBox()
    if (b && b.y + b.height < SIZE - 40) break
  }
  await page.waitForTimeout(250)
  await tap(page, (await submit.boundingBox())!)
  await page.waitForTimeout(120)
  await rec.pause()

  // The same poll decided: the winner, and the runoff that elected it.
  await page.goto('#/sample-result-dinner')
  const winner = page.getByText(/^Winner: /)
  await winner.waitFor()
  await page.mouse.move(SIZE * 0.85, SIZE * 0.95)
  // The banner a third of the way down, where the circle is nearly its full
  // width: any higher and the circle's edge cuts the start of the name off.
  await winner.evaluate((el, at) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - at)
  }, SIZE * 0.32)
  await rec.resume()
  await page.waitForTimeout(1900)
  await rec.save('place', 900)
})

test('time', async ({ page }) => {
  await page.addInitScript(FINGER)
  await page.goto('#/sample-when')
  await page.getByLabel('Your name').fill('Sam')
  const friday = page.getByRole('button', { name: /Fill the whole day 2026-02-20/ })
  await friday.waitFor()
  await page.getByText(/All times are/).evaluate((el) => {
    window.scrollTo(0, el.getBoundingClientRect().bottom + window.scrollY - 6)
  })
  // The week scrolls sideways at this width; Friday and Saturday into view.
  // The week scrolls sideways at this width: the line between Friday and
  // Saturday to the middle of the frame, which is the middle of the circle.
  await friday.evaluate((el, mid) => {
    let box = el.parentElement
    while (box && box.scrollWidth <= box.clientWidth) box = box.parentElement
    if (box) box.scrollLeft += el.getBoundingClientRect().right - mid
  }, SIZE / 2)
  await page.mouse.move(SIZE * 0.85, SIZE * 0.95)
  await page.waitForTimeout(400)

  /** The paintable cells under a day's heading, top to bottom. */
  async function column(date: string) {
    return page.evaluate((day) => {
      return [...document.querySelectorAll(`[data-drag-slot-group="${day}"]:not([disabled])`)]
        .map((el) => el.getBoundingClientRect())
        .sort((a, b) => a.top - b.top)
        .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))
    }, date)
  }

  async function stroke(cells: { x: number; y: number }[], from: number, to: number) {
    const visible = cells.filter((c) => c.y > 30 && c.y < SIZE - 20)
    const a = visible[Math.min(from, visible.length - 1)]
    const b = visible[Math.min(to, visible.length - 1)]
    await page.mouse.move(a.x, a.y, { steps: 14 })
    await page.waitForTimeout(80)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 26 })
    await page.waitForTimeout(80)
    await page.mouse.up()
  }

  // Friday evening a little below the top of the frame. The brush is above
  // it and out of sight, so it is changed without the fingertip.
  const fri = await column('2026-02-20')
  await page.evaluate((dy) => window.scrollBy(0, dy), fri[0].y - 270)
  // Clicking the brush focuses it, and focusing it scrolls it into view; the
  // scroll is put back before anything is drawn.
  const brush = (n: number) =>
    page.getByText(String(n), { exact: true }).evaluate((el) => {
      const y = window.scrollY
      ;(el as HTMLElement).click()
      window.scrollTo(0, y)
    })

  const rec = new Recorder(page)
  await rec.start()
  await page.waitForTimeout(500)
  // A 5 down Friday evening, then a 3 and a 1 down Saturday afternoon, so the
  // loop shows the ramp rather than one colour.
  await stroke(await column('2026-02-20'), 0, 7)
  await page.waitForTimeout(300)
  await brush(3)
  await stroke(await column('2026-02-21'), 1, 5)
  await page.waitForTimeout(250)
  await brush(1)
  await stroke(await column('2026-02-21'), 6, 8)
  await page.waitForTimeout(250)
  await page.mouse.move(SIZE * 0.85, SIZE * 0.95, { steps: 14 })
  await page.waitForTimeout(700)
  await rec.save('time', 1200)
})
