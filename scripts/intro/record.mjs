// Records the intro's app footage in the capture browser (browser.mjs), as
// the signed-in test account, on the live site: one poll made, filled by
// scripted strangers, decided, and followed back to the poll list. Writes an
// mp4 and the time each section starts (sections.json) to the output folder,
// then deletes the poll it made.
//
//   node scripts/intro/record.mjs <out dir> [stop after section]
//
// The window has to stay visible while it records: Edge stops drawing frames
// for a covered window.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach, deleteGroup, deleteTitled, pause, SITE, stranger, tokenOf } from './lib.mjs'

const OUT = process.argv[2] ?? 'intro-take'
const STOP = process.argv[3]
const W = 1280
const H = 800
const SCALE = 1.5

/** Frames from Chromium's screencast, each with the moment it was drawn. */
class Recorder {
  frames = []
  cuts = new Set()
  marks = []
  constructor(page, dir) {
    this.page = page
    this.dir = dir
  }
  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page)
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: SCALE,
      mobile: false,
    })
    this.cdp.on('Page.screencastFrame', (f) => {
      const file = join(this.dir, `${String(this.frames.length).padStart(5, '0')}.png`)
      writeFileSync(file, Buffer.from(f.data, 'base64'))
      this.frames.push({ file, at: f.metadata.timestamp ?? 0 })
      void this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
  }
  async resume() {
    await this.cdp.send('Page.startScreencast', {
      format: 'png',
      everyNthFrame: 1,
      maxWidth: W * SCALE,
      maxHeight: H * SCALE,
    })
  }
  /** Stops recording; what happens until `resume` is cut out. */
  async cut() {
    await this.cdp.send('Page.stopScreencast')
    this.cuts.add(this.frames.length)
  }
  /** A section starts at the next frame. */
  mark(name) {
    this.marks.push({ name, frame: this.frames.length })
    console.log('section', name)
  }
  /** Holds the last frame, writes the mp4 and when each section starts. */
  async save(holdMs) {
    await this.cdp.send('Page.stopScreencast').catch(() => {})
    const lines = []
    const starts = []
    let t = 0
    this.frames.forEach((f, i) => {
      for (const m of this.marks)
        if (m.frame === i) starts.push({ name: m.name, at: +t.toFixed(3) })
      const next = this.frames[i + 1]
      const cut = this.cuts.has(i + 1)
      const d = next && !cut ? Math.max(next.at - f.at, 1 / 60) : cut ? 1 / 30 : holdMs / 1000
      lines.push(`file '${f.file.replaceAll('\\', '/')}'`, `duration ${d.toFixed(4)}`)
      t += d
    })
    lines.push(lines[lines.length - 2])
    const list = join(this.dir, 'list.txt')
    writeFileSync(list, lines.join('\n'))
    execFileSync('ffmpeg', [
      ...['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list],
      ...['-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24'],
      ...['-movflags', '+faststart', '-an', join(OUT, 'landscape.mp4')],
    ])
    writeFileSync(
      join(OUT, 'sections.json'),
      JSON.stringify({ length: +t.toFixed(3), starts }, null, 2),
    )
  }
}

/**
 * A desktop pointer, since the screencast draws none, and the header's
 * account address hidden (it is the test account's).
 */
async function dress(page) {
  await page.evaluate(() => {
    if (document.getElementById('capture-pointer')) return
    const ptr = document.createElement('div')
    ptr.id = 'capture-pointer'
    ptr.innerHTML =
      '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 23 L7.5 17.5 L11.5 26 L15 24.5 L11 16 L19 16 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    ptr.style.cssText =
      'position:fixed;left:-40px;top:-40px;pointer-events:none;z-index:2147483647;transform-origin:2px 2px;transition:transform 100ms;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))'
    document.documentElement.appendChild(ptr)
    addEventListener(
      'mousemove',
      (e) => {
        ptr.style.left = e.clientX - 2 + 'px'
        ptr.style.top = e.clientY - 2 + 'px'
      },
      true,
    )
    addEventListener('mousedown', () => (ptr.style.transform = 'scale(.85)'), true)
    addEventListener('mouseup', () => (ptr.style.transform = ''), true)
    const style = document.createElement('style')
    style.textContent = '.mantine-Notifications-root{display:none!important}'
    document.head.appendChild(style)
    for (const el of document.querySelectorAll('header *'))
      if (el.children.length === 0 && el.textContent?.includes('@')) el.style.visibility = 'hidden'
  })
}

const { page } = await attach()
const token = await tokenOf(page)
// A take that crashed leaves its poll behind.
await deleteTitled(token, 'Movie night')
const dir = join(OUT, 'frames')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const rec = new Recorder(page, dir)
await rec.start()

/** Where the pointer is, so each move glides from there. */
let at = { x: W * 0.75, y: H * 0.9 }
async function glide(x, y, steps = 18) {
  await page.mouse.move(x, y, { steps })
  at = { x, y }
}
async function click(locator, { settle = 120 } = {}) {
  await scrollTo(locator)
  const b = await locator.boundingBox()
  await glide(b.x + b.width / 2, b.y + b.height / 2)
  await pause(90)
  await page.mouse.down()
  await pause(70)
  await page.mouse.up()
  await pause(settle)
}
async function type(locator, text) {
  await click(locator)
  await page.keyboard.type(text, { delay: 40 })
}
/**
 * Glides the page until `locator` is comfortably on screen — its top at `top`
 * when given, otherwise only if it is near an edge — easing in and out the way
 * a trackpad does, rather than the jump Playwright makes before a click.
 */
async function scrollTo(locator, top) {
  await locator.waitFor()
  const b = await locator.boundingBox()
  let dy = 0
  if (top !== undefined) dy = b.y - top
  else if (b.y < 80) dy = b.y - H * 0.3
  else if (b.y + b.height > H - 60) dy = b.y + b.height - H * 0.65
  if (Math.abs(dy) < 2) return
  await page.evaluate(
    (dy) =>
      new Promise((done) => {
        const from = window.scrollY
        const to = Math.max(
          0,
          Math.min(from + dy, document.documentElement.scrollHeight - innerHeight),
        )
        const ms = Math.min(1100, 380 + Math.abs(to - from) * 0.7)
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
        const start = performance.now()
        const step = (now) => {
          const t = Math.min(1, (now - start) / ms)
          window.scrollTo({ top: from + (to - from) * ease(t), behavior: 'instant' })
          if (t < 1) requestAnimationFrame(step)
          else done()
        }
        requestAnimationFrame(step)
      }),
    dy,
  )
  await pause(150)
}
/** A Mantine select, set without the pointer (only ever off camera). */
async function pick(label, option) {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await pause(150)
}
const done = (name) => STOP === name

// ── Make a poll ───────────────────────────────────────────────────────────
// A load of its own, so nothing is left over from a take before: changing
// only the hash would keep the form as the last take left it.
await page.goto(SITE + '#/new')
// The name box offers back the last name typed; each take types its own.
await page.evaluate(() => localStorage.removeItem('star-voting:voter-name'))
await page.reload()
await page.getByText('Find a time').first().waitFor()
await dress(page)
await page.mouse.move(at.x, at.y)
await rec.resume()
rec.mark('make')
await pause(500)
await type(page.getByPlaceholder('A title for your poll'), 'Movie night')
await type(
  page.getByPlaceholder('Optional additional details'),
  'Pick a film, then a night to watch it.',
)
await click(page.getByText('Anyone with the link'))
await click(page.getByText('Show voter names'))
await click(page.getByText('Solicit options from voters'))
await click(page.getByText('Multiple questions'))
await pause(300)
await type(page.getByPlaceholder('What is this question asking?'), 'Which movie?')
await click(page.getByRole('tab', { name: 'Question 2' }), { settle: 400 })
await type(page.getByPlaceholder('What is this question asking?'), 'Which night?')
await click(page.getByText('Find a time'), { settle: 1500 })
await rec.cut()
// The selects are set off camera: they are slow to watch and say little.
await pick('Length', '2 hours')
await pick('Earliest start', '6:00pm')
await pick('Latest end', '11:00pm')
await scrollTo(page.getByRole('button', { name: /^Fill the whole day/ }).first(), 160)
await rec.resume()
await pause(300)
for (const day of ['2026-10-30', '2026-10-31'])
  await click(page.getByRole('button', { name: `Fill the whole day ${day}` }), { settle: 450 })
await click(page.getByRole('button', { name: 'Create poll' }))
await page.waitForURL(/#\/[A-Za-z0-9_-]{22}$/)
const short = await page.evaluate(() => location.hash.slice(2))
const hex = Buffer.from(short, 'base64url').toString('hex')
const pollId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
const groupId = (await stranger('reader').view(pollId)).poll.group_id
const questions = await stranger('reader').group(pollId)
const [movieQ, nightQ] = questions
  .sort((a, b) => a.question_position - b.question_position)
  .map((q) => q.id)
await pause(1500)
if (done('make')) await finish()

// ── Collect options ───────────────────────────────────────────────────────
// Three strangers holding the link each suggest a film and confirm.
const people = ['Alex', 'Sam', 'Priya', 'Jordan', 'Mei', 'Luis'].map(stranger)
const FILMS = [
  ['Alien', "We should watch a scary movie since it's October!"],
  ['Nomadland', 'This won Best Picture at the Oscars'],
  ['Airplane', "You must watch this if you haven't seen it before"],
]
await rec.cut()
rec.mark('collect')
await rec.resume()
await pause(900)
for (const [i, [name, description]] of FILMS.entries()) {
  await people[i].suggest(movieQ, [{ name, description }])
  await people[i].confirm(movieQ)
  await pause(1700)
}
// We have had our say too, under the name we will vote with; then the poll
// opens.
await type(page.getByLabel('Your name'), 'Rob')
await click(page.getByRole('button', { name: 'Confirm options' }), { settle: 1100 })
await click(page.getByRole('button', { name: 'Open poll' }).first(), { settle: 500 })
await click(page.getByRole('dialog').getByRole('button', { name: 'Open poll' }))
await page.getByRole('button', { name: 'Submit vote' }).waitFor()
await pause(600)
if (done('collect')) await finish()

// ── Rate the options ──────────────────────────────────────────────────────
// The name typed to confirm is still in its box.
rec.mark('rate')
await scrollTo(page.getByLabel('Your name'), 150)
await pause(300)
for (const [name, stars] of [
  ['Alien', 5],
  ['Nomadland', 3],
  ['Airplane', 4],
]) {
  const row = page.getByRole('radiogroup', { name: `Score for ${name}` })
  await click(row.getByRole('radio', { name: `${stars} stars`, exact: true }), { settle: 250 })
}
await click(page.getByRole('button', { name: 'Submit vote' }))
// The page moves on to the next question by itself.
await page.locator('[data-drag-slot-group]').first().waitFor()
await pause(900)
if (done('rate')) await finish()

// ── Rate the times ────────────────────────────────────────────────────────
await rec.cut()
const firstCell = page.locator('[data-drag-slot-group="2026-10-30"]:not([disabled])').first()
await scrollTo(page.getByText(/All times are/), 70)
rec.mark('times')
await rec.resume()
await pause(400)
/** The paintable cells under a day's heading, top to bottom. */
const column = (day) =>
  page.evaluate(
    (d) =>
      [...document.querySelectorAll(`[data-drag-slot-group="${d}"]:not([disabled])`)]
        .map((el) => el.getBoundingClientRect())
        .sort((a, b) => a.top - b.top)
        .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })),
    day,
  )
async function stroke(cells, from, to) {
  const a = cells[Math.min(from, cells.length - 1)]
  const b = cells[Math.min(to, cells.length - 1)]
  await glide(a.x, a.y)
  await pause(80)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 24 })
  await pause(80)
  await page.mouse.up()
  await pause(250)
}
const brush = (n) => click(page.getByText(String(n), { exact: true }).first(), { settle: 150 })
await firstCell.waitFor()
await brush(5)
await stroke(await column('2026-10-31'), 0, 5)
await brush(3)
await stroke(await column('2026-10-30'), 2, 5)
await click(page.getByRole('button', { name: 'Submit vote' }))
await pause(1200)
if (done('times')) await finish()

// ── Votes come in ─────────────────────────────────────────────────────────
await rec.cut()
const roster = page.getByRole('heading', { name: 'Voters' }).first()
await roster.waitFor()
await scrollTo(roster, 200)
rec.mark('votes')
await rec.resume()
await pause(700)
const MOVIE_VOTES = [
  { Alien: 5, Nomadland: 2, Airplane: 3 },
  { Alien: 1, Nomadland: 5, Airplane: 4 },
  { Alien: 5, Nomadland: 1, Airplane: 3 },
  { Alien: 5, Nomadland: 3, Airplane: 2 },
  { Alien: 3, Nomadland: 4, Airplane: 4 },
]
/**
 * Saturday evening suits most people, Friday less. Each voter has a favourite
 * start and likes a window less the further it is from it: windows scored all
 * alike would tie in the runoff, which has no random fallback.
 */
const FAVOURITE = [18.5, 19, 18.5, 18, 19.5]
const night = (i) => (name) => {
  const [, day, h, m] = name.match(/^2026-10-(\d\d)T(\d\d):(\d\d)/)
  const off = Math.abs(+h + +m / 60 - FAVOURITE[i]) * 2
  return Math.max(0, Math.round((day === '31' ? 5 : 3) - off))
}
for (const [i, scores] of MOVIE_VOTES.entries()) {
  await people[i].vote(movieQ, scores)
  await people[i].vote(nightQ, night(i))
  await pause(1100)
}
await pause(800)
if (done('votes')) await finish()

// ── A decision ────────────────────────────────────────────────────────────
await rec.cut()
const close = page.getByRole('button', { name: 'Close poll' }).first()
await scrollTo(close, 400)
rec.mark('decide')
await rec.resume()
await pause(300)
await click(close, { settle: 500 })
await click(page.getByRole('dialog').getByRole('button', { name: 'Close poll' }), { settle: 300 })
// The results as somebody opening the poll sees them: a fresh load, at the
// top, recorded from the moment they are drawn so the bars are seen growing.
await rec.cut()
await page.goto(SITE + '#/' + short)
await page.reload()
await dress(page)
await page.mouse.move(W * 0.82, H * 0.6)
await page
  .getByText(/^Winner: /)
  .first()
  .waitFor({ timeout: 60_000 })
await rec.resume()
await pause(3400)
if (done('decide')) await finish()

// ── Back to the list ──────────────────────────────────────────────────────
rec.mark('list')
await click(page.getByRole('link', { name: 'Your polls' }).first())
await pause(2500)
await finish()

/** Writes the take, leaves a still of the last frame, and deletes the poll. */
async function finish() {
  await rec.save(800)
  await page.screenshot({ path: join(OUT, 'last.png') })
  if (groupId) await deleteGroup(token, groupId)
  console.log('wrote', OUT)
  process.exit(0)
}
