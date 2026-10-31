// Records the intro's app footage in the capture browser (browser.mjs), as
// the signed-in test account, on the live site: one poll made, filled by
// scripted strangers, decided, and followed back to the poll list. Writes
// `<shape>.mp4`, a poster of its first frame, and `<shape>.json` (where the
// header's logo sits, for the film's opening and closing flights) to the
// output folder, then deletes the poll it made.
//
//   node scripts/intro/record.mjs <out dir> [--portrait] [--publish] [stop after section]
//
// Landscape is a desktop browser at 1280×800; --portrait is a phone at
// 390×844. Each section is sped up, or held on its last frame, to the length
// src/components/intro/sections.json gives it, so the two cuts share one
// timeline and the film can swap between them mid-play. --publish copies the
// take into public/intro/ and its logo position into
// src/components/intro/footage.json.
//
// The window has to stay visible while it records: Edge stops drawing frames
// for a covered window.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { attach, deleteGroup, deleteTitled, pause, SITE, stranger, tokenOf } from './lib.mjs'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [out, STOP] = args.filter((a) => !a.startsWith('--'))
const OUT = resolve(out ?? 'intro-take')
const SHAPE = flags.has('--portrait') ? 'portrait' : 'landscape'
const PHONE = SHAPE === 'portrait'
const W = PHONE ? 390 : 1280
const H = PHONE ? 844 : 800
const SCALE = PHONE ? 3 : 1.5
/** The size the video is encoded at: the phone's frames halved, which is plenty for a phone. */
const ENCODE = PHONE ? { w: 780, h: 1688 } : { w: 1920, h: 1200 }
const SECTIONS = JSON.parse(readFileSync('src/components/intro/sections.json', 'utf8'))
/** The frame rate the video is encoded at. */
const FPS = 60
/** How much faster than life a section may play before the take warns about it. */
const MAX_SPEEDUP = 1.15
/** The poll's two nights: the coming Friday (today, if it is one) and the Saturday after. */
const [FRIDAY, SATURDAY] = [0, 1].map((extra) => {
  const d = new Date()
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7) + extra)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})

/** Frames from Chromium's screencast, each with the moment it was drawn. */
class Recorder {
  frames = []
  writes = []
  cuts = new Set()
  marks = []
  recording = false
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
      mobile: PHONE,
    })
    // The browser sends the next frame only once this one is acknowledged, so
    // it is acknowledged first and written afterwards: a frame held up on the
    // disk is a frame the browser never sends.
    this.cdp.on('Page.screencastFrame', (f) => {
      void this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
      // A frame still on its way when a cut began belongs to the cut.
      if (!this.recording) return
      const file = join(this.dir, `${String(this.frames.length).padStart(5, '0')}.jpg`)
      this.frames.push({ file, at: f.metadata.timestamp ?? 0 })
      this.writes.push(writeFile(file, Buffer.from(f.data, 'base64')))
    })
  }
  async resume() {
    this.recording = true
    // JPEG at full quality rather than PNG: PNG is slow enough to encode at
    // this size that the browser manages about a dozen frames a second, and
    // the mp4 is lossy anyway.
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 100,
      everyNthFrame: 1,
      maxWidth: W * SCALE,
      maxHeight: H * SCALE,
    })
  }
  /** Stops recording; what happens until `resume` is cut out. */
  async cut() {
    this.recording = false
    await this.cdp.send('Page.stopScreencast')
    this.cuts.add(this.frames.length)
  }
  /** A section starts at the next frame. */
  mark(name) {
    this.marks.push({ name, frame: this.frames.length })
    console.log('section', name)
  }
  /**
   * Writes the mp4, each section fitted to its length in sections.json: sped
   * up evenly when it ran long, held on its last frame when it ran short.
   * Sections not reached (a take stopped early) keep their own pace.
   */
  async save() {
    this.recording = false
    await this.cdp.send('Page.stopScreencast').catch(() => {})
    await Promise.all(this.writes)
    const lengths = this.frames.map((f, i) => {
      const next = this.frames[i + 1]
      if (!next) return 1 / FPS
      // A pause in the recording is a cut, not a wait.
      return this.cuts.has(i + 1) ? 1 / FPS : Math.max(next.at - f.at, 1 / (2 * FPS))
    })
    this.marks.forEach((m, k) => {
      const target = SECTIONS.find((s) => s.name === m.name)?.seconds
      const end = this.marks[k + 1]?.frame ?? this.frames.length
      if (!target || end <= m.frame) return
      const raw = lengths.slice(m.frame, end).reduce((a, b) => a + b, 0)
      const speed = raw / target
      console.log(
        `${m.name}: ${raw.toFixed(1)}s recorded for ${target}s,`,
        speed > 1 ? `played ${speed.toFixed(2)}× fast,` : 'held at the end,',
        `${((end - m.frame) / raw).toFixed(0)} frames a second captured`,
      )
      // Sped up much past life, a section reads as a blur of clicks.
      if (speed > MAX_SPEEDUP)
        console.warn(
          `  hurried: give ${m.name} about ${Math.ceil(raw / MAX_SPEEDUP)}s in sections.json`,
        )
      if (raw > target) for (let i = m.frame; i < end; i++) lengths[i] *= target / raw
      else lengths[end - 1] += target - raw
    })
    // Laid on the output's own grid here, each output frame showing whichever
    // capture was on screen at its moment: handed the captures' own uneven
    // durations (half of them under a sixtieth), ffmpeg's concat drifts by
    // seconds over a take.
    const total = lengths.reduce((a, b) => a + b, 0)
    const lines = []
    let shown = 0
    let ends = lengths[0]
    for (let k = 0; k < Math.round(total * FPS); k++) {
      while ((k + 0.5) / FPS > ends && shown < this.frames.length - 1) ends += lengths[++shown]
      lines.push(`file '${this.frames[shown].file.replaceAll('\\', '/')}'`, `duration ${1 / FPS}`)
    }
    lines.push(lines[lines.length - 2])
    const list = join(this.dir, 'list.txt')
    writeFileSync(list, lines.join('\n'))
    const scale = `scale=${ENCODE.w}:${ENCODE.h}:flags=lanczos`
    execFileSync('ffmpeg', [
      ...['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list],
      ...['-vf', `${scale},fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow'],
      ...['-crf', '24', '-movflags', '+faststart', '-an', join(OUT, `${SHAPE}.mp4`)],
    ])
    execFileSync('ffmpeg', [
      ...['-y', '-loglevel', 'error', '-i', this.frames[0].file, '-vf', scale],
      ...['-q:v', '3', join(OUT, `${SHAPE}.jpg`)],
    ])
    console.log('length', total.toFixed(2), 's')
  }
}

/**
 * A pointer, since the screencast draws none — an arrow on the desktop, and on
 * the phone a fingertip that is there only while it presses — and the
 * header's account address hidden (it is the test account's).
 */
async function dress(page) {
  await page.evaluate((phone) => {
    if (document.getElementById('capture-pointer')) return
    const ptr = document.createElement('div')
    ptr.id = 'capture-pointer'
    if (phone) {
      ptr.style.cssText =
        'position:fixed;left:-60px;top:-60px;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;' +
        'background:rgba(30,30,40,.28);border:2px solid rgba(255,255,255,.9);box-shadow:0 1px 6px rgba(0,0,0,.3);' +
        'pointer-events:none;z-index:2147483647;opacity:0;transform:scale(1.3);transition:opacity 160ms,transform 160ms'
    } else {
      ptr.innerHTML =
        '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 23 L7.5 17.5 L11.5 26 L15 24.5 L11 16 L19 16 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
      ptr.style.cssText =
        'position:fixed;left:-40px;top:-40px;pointer-events:none;z-index:2147483647;transform-origin:2px 2px;transition:transform 100ms;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))'
    }
    document.documentElement.appendChild(ptr)
    const offset = phone ? 0 : 2
    addEventListener(
      'mousemove',
      (e) => {
        ptr.style.left = e.clientX - offset + 'px'
        ptr.style.top = e.clientY - offset + 'px'
      },
      true,
    )
    addEventListener(
      'mousedown',
      () => {
        ptr.style.transform = phone ? 'scale(1)' : 'scale(.85)'
        if (phone) ptr.style.opacity = '1'
      },
      true,
    )
    addEventListener(
      'mouseup',
      () => {
        ptr.style.transform = phone ? 'scale(1.3)' : ''
        if (phone) ptr.style.opacity = '0'
      },
      true,
    )
    const style = document.createElement('style')
    style.textContent = '.mantine-Notifications-root{display:none!important}'
    document.head.appendChild(style)
    for (const el of document.querySelectorAll('header *'))
      if (el.children.length === 0 && el.textContent?.includes('@')) el.style.visibility = 'hidden'
    // The address anywhere else (the create form's "Include me as a voter")
    // reads as a stand-in, however often React draws it again.
    let email = null
    try {
      const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k))
      email = JSON.parse(localStorage.getItem(key)).user.email
    } catch {
      // Not signed in: nothing to hide.
    }
    if (!email) return
    const swap = (node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      for (let n = node.nodeType === 3 ? node : walker.nextNode(); n; n = walker.nextNode())
        if (n.nodeValue.includes(email))
          n.nodeValue = n.nodeValue.replaceAll(email, 'you@example.com')
    }
    swap(document.body)
    new MutationObserver((changes) => {
      for (const c of changes) {
        if (c.type === 'characterData') swap(c.target)
        c.addedNodes.forEach(swap)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, PHONE)
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
// A take that fails leaves a picture of where it stopped.
process.on('uncaughtException', async (error) => {
  console.error(error)
  await page.screenshot({ path: join(OUT, 'failed.png') }).catch(() => {})
  process.exit(1)
})

/** Where the pointer is, so each move glides from there. */
let at = { x: W * 0.75, y: H * 0.9 }
/**
 * Moves the pointer the way a hand does: easing in and out, quicker over a
 * long way but never instant, one step a frame. (`mouse.move` with `steps`
 * goes as fast as the browser answers, which on camera is a jump.)
 */
async function glide(x, y) {
  const from = at
  const ms = Math.min(750, 280 + Math.hypot(x - from.x, y - from.y) * 0.45)
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
  const start = Date.now()
  for (let t = 0; t < 1;) {
    await pause(16)
    t = Math.min(1, (Date.now() - start) / ms)
    const k = ease(t)
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k)
  }
  at = { x, y }
}
async function click(locator, { settle = 350 } = {}) {
  await scrollTo(locator)
  const b = await locator.boundingBox()
  await glide(b.x + b.width / 2, b.y + b.height / 2)
  await pause(150)
  await page.mouse.down()
  await pause(70)
  await page.mouse.up()
  await pause(settle)
}
async function type(locator, text) {
  await click(locator)
  await page.keyboard.type(text, { delay: 85 })
  await pause(250)
}
/**
 * Glides the page until `locator` is comfortably on screen — its top at `top`
 * when given, otherwise only if it is near an edge — easing in and out the way
 * a trackpad does, rather than the jump Playwright makes before a click. An
 * element off to the side in a box that scrolls sideways (the week calendar
 * on a phone) is brought in by scrolling that box at the same time.
 */
async function scrollTo(locator, top) {
  await locator.waitFor()
  const moved = await locator.evaluate(
    (el, { top, H }) => {
      const b = el.getBoundingClientRect()
      let dy = 0
      if (top !== null) dy = b.top - top
      else if (b.top < 80) dy = b.top - H * 0.3
      else if (b.bottom > H - 60) dy = b.bottom - H * 0.65
      let box = el.parentElement
      while (
        box &&
        !(box.scrollWidth > box.clientWidth + 1 && getComputedStyle(box).overflowX !== 'visible')
      )
        box = box.parentElement
      let dx = 0
      if (box && box !== document.documentElement && box !== document.body) {
        const r = box.getBoundingClientRect()
        if (b.left < r.left + 8 || b.right > r.right - 8)
          dx = b.left + b.width / 2 - (r.left + r.width / 2)
      }
      if (Math.abs(dy) < 2 && Math.abs(dx) < 2) return false
      return new Promise((done) => {
        const fromY = window.scrollY
        const toY = Math.max(
          0,
          Math.min(fromY + dy, document.documentElement.scrollHeight - innerHeight),
        )
        const fromX = box ? box.scrollLeft : 0
        const toX = box ? Math.max(0, Math.min(fromX + dx, box.scrollWidth - box.clientWidth)) : 0
        const ms = Math.min(
          1100,
          380 + Math.max(Math.abs(toY - fromY), Math.abs(toX - fromX)) * 0.7,
        )
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
        const start = performance.now()
        const step = (now) => {
          const t = Math.min(1, (now - start) / ms)
          window.scrollTo({ top: fromY + (toY - fromY) * ease(t), behavior: 'instant' })
          if (box && dx) box.scrollLeft = fromX + (toX - fromX) * ease(t)
          if (t < 1) requestAnimationFrame(step)
          else done(true)
        }
        requestAnimationFrame(step)
      })
    },
    { top: top ?? null, H },
  )
  if (moved) await pause(150)
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
// The name box offers back the last name typed, and a blank form starts from
// the last poll's settings (the last take's); each take starts from nothing.
await page.evaluate(() => {
  localStorage.removeItem('star-voting:voter-name')
  localStorage.removeItem('star-voting:poll-defaults')
})
await page.reload()
await page.getByText('Find a time').first().waitFor()
await dress(page)
await page.mouse.move(at.x, at.y)
// Where the film's logo lands and takes off from: the header's own.
const logo = await page.locator('header img').first().boundingBox()
await rec.resume()
rec.mark('make')
await pause(500)
await type(page.getByPlaceholder('A title for your poll'), 'Movie night')
await click(page.getByText('Anyone with the link'))
await click(page.getByText('Show voter names'))
await click(page.getByText('Solicit options from voters'))
await click(page.getByText('Multiple questions'))
await pause(300)
await type(page.getByPlaceholder('What is this question asking?'), 'Which movie?')
await click(page.getByRole('tab', { name: 'Question 2' }), { settle: 400 })
await type(page.getByPlaceholder('What is this question asking?'), 'Which night?')
await click(page.getByText('Find a time'), { settle: 1500 })
// The selects are set off camera: they are slow to watch and say little.
// Opening one scrolls the page, so it is put back before recording resumes
// and the way down to the calendar is seen.
await rec.cut()
const keptY = await page.evaluate(() => window.scrollY)
await pick('Length', '2 hours')
await pick('Earliest start', '6:00pm')
await pick('Latest end', '11:00pm')
// The calendar opens on this week, which may have no Friday left in it. It is
// turned off camera too, by a click that scrolls nothing.
const friday = page.getByRole('button', { name: `Fill the whole day ${FRIDAY}` })
if (!(await friday.count())) {
  await page.evaluate(() => document.querySelector('[aria-label="Next week"]').click())
  await friday.waitFor()
}
await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), keptY)
await pause(200)
await rec.resume()
await scrollTo(page.getByRole('button', { name: /^Fill the whole day/ }).first(), 160)
await pause(300)
for (const day of [FRIDAY, SATURDAY])
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
await click(page.getByRole('button', { name: 'Open poll' }).first(), { settle: 500 })
await click(page.getByRole('dialog').getByRole('button', { name: 'Open poll' }))
await page.getByRole('button', { name: 'Submit vote' }).waitFor()
await pause(600)
if (done('collect')) await finish()

// ── Rate the options ──────────────────────────────────────────────────────
rec.mark('rate')
await type(page.getByLabel('Your name'), 'Rob')
for (const [name, stars] of [
  ['Alien', 5],
  ['Nomadland', 3],
  ['Airplane', 4],
]) {
  const row = page.getByRole('radiogroup', { name: `Score for ${name}` })
  await click(row.getByRole('radio', { name: `${stars} stars`, exact: true }), { settle: 400 })
}
await click(page.getByRole('button', { name: 'Submit vote' }))
// The page moves on to the next question by itself.
await page.locator('[data-drag-slot-group]').first().waitFor()
await pause(900)
if (done('rate')) await finish()

// ── Rate the times ────────────────────────────────────────────────────────
const firstCell = page.locator(`[data-drag-slot-group="${FRIDAY}"]:not([disabled])`).first()
rec.mark('times')
// Low enough that the brush beside this line is clear of the top edge, or
// pressing it would scroll the page back again.
await scrollTo(page.getByText(/All times are/), 150)
await pause(300)
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
  await pause(150)
  await page.mouse.down()
  await glide(b.x, b.y)
  await pause(150)
  await page.mouse.up()
  await pause(400)
}
const brush = (n) => click(page.getByText(String(n), { exact: true }).first())
await firstCell.waitFor()
// On a phone the week is wider than the screen: Friday and Saturday into view.
await scrollTo(firstCell)
// The brush starts on 5, so the first stroke needs no press.
await stroke(await column(SATURDAY), 0, 5)
await brush(3)
await stroke(await column(FRIDAY), 2, 5)
await click(page.getByRole('button', { name: 'Submit vote' }))
await pause(1200)
if (done('times')) await finish()

// ── Votes come in ─────────────────────────────────────────────────────────
const roster = page.getByRole('heading', { name: 'Voters' }).first()
rec.mark('votes')
await scrollTo(roster, 200)
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
  const [, day, h, m] = name.match(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)/)
  const off = Math.abs(+h + +m / 60 - FAVOURITE[i]) * 2
  return Math.max(0, Math.round((day === SATURDAY ? 5 : 3) - off))
}
for (const [i, scores] of MOVIE_VOTES.entries()) {
  await people[i].vote(movieQ, scores)
  await people[i].vote(nightQ, night(i))
  await pause(650)
}
await pause(800)
if (done('votes')) await finish()

// ── A decision ────────────────────────────────────────────────────────────
const close = page.getByRole('button', { name: 'Close poll' }).first()
rec.mark('decide')
await scrollTo(close, 400)
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
// Then the night it chose, on the second question's tally.
await click(page.getByRole('link', { name: /Which night\?/ }).first())
await page
  .getByText(/^Winner: .*Sat/)
  .first()
  .waitFor()
await pause(3400)
if (done('decide')) await finish()

// ── Back to the list ──────────────────────────────────────────────────────
rec.mark('list')
await scrollTo(page.getByRole('link', { name: 'Your polls' }).first(), 150)
await click(page.getByRole('link', { name: 'Your polls' }).first())
await pause(2500)
await finish()

/**
 * Writes the take, leaves a still of the last frame, deletes the poll, and
 * with --publish puts the take where the film reads it.
 */
async function finish() {
  await rec.save()
  await page.screenshot({ path: join(OUT, 'last.png') })
  if (groupId) await deleteGroup(token, groupId)
  // In the viewport's own pixels; the film scales them to the screen it draws.
  const meta = {
    w: W,
    h: H,
    logo: { x: logo.x + logo.width / 2, y: logo.y + logo.height / 2, size: logo.width },
  }
  writeFileSync(join(OUT, `${SHAPE}.json`), JSON.stringify(meta, null, 2) + '\n')
  if (flags.has('--publish')) {
    mkdirSync('public/intro', { recursive: true })
    for (const ext of ['mp4', 'jpg'])
      copyFileSync(join(OUT, `${SHAPE}.${ext}`), `public/intro/${SHAPE}.${ext}`)
    const file = 'src/components/intro/footage.json'
    let all = {}
    try {
      all = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // The first take published.
    }
    writeFileSync(file, JSON.stringify({ ...all, [SHAPE]: meta }, null, 2) + '\n')
  }
  console.log('wrote', OUT)
  process.exit(0)
}
