// Renders the whole intro film — the footage with its captions, bars and the
// logo's flights, as the /intro page draws it — to one video file, for
// posting somewhere a link would not play (a Reddit upload, say).
//
//   node scripts/intro/export.mjs <out.mp4> [--portrait] [--fps 30] [--site http://localhost:4173/]
//
// Landscape is 1920×1080; --portrait is 1080×1920. The site defaults to the
// live one, so export after deploying the footage; `npm run build && npm run
// preview` and --site exports a local build instead.
//
// It is rendered frame by frame, not recorded, so nothing is dropped however
// slowly a frame draws: the page's animation frames are fired by hand, and
// the footage is stepped by seeking. The page's own clock follows the video
// while the footage is on (followVideo in Intro.tsx), so stepping the video
// is what steps the film. Everything the page draws over the film (the
// buttons, Skip) is hidden, and the take ends when the film does.
//
// It needs Edge (for H.264, which Playwright's own Chromium cannot play) and
// ffmpeg on the PATH. No account and no capture browser.
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const FPS = Number(option('--fps') ?? 60)
// The film's clock steps at most a tenth of a second a frame (useFilmClock),
// so below ten frames a second the parts outside the footage run slow.
if (!(FPS >= 10)) throw new Error('--fps must be at least 10')
const site = option('--site') ?? 'https://choicelab.app/'
const PORTRAIT = args.includes('--portrait')
const [out] = args.filter((a) => !a.startsWith('--'))
if (!out) throw new Error('Usage: node scripts/intro/export.mjs <out.mp4> [--portrait] [--fps n]')
const OUT = resolve(out)
mkdirSync(dirname(OUT), { recursive: true })
const SIZE = PORTRAIT ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
/** A ceiling, in case the page never says it has ended: two minutes of film. */
const MAX_FRAMES = FPS * 120

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
  serviceWorkers: 'block',
})

// Installed before the app runs: animation frames wait for `__step`, and the
// footage plays only as far as `__step` seeks it.
await context.addInitScript((fps) => {
  let now = 0
  let queue = []
  window.requestAnimationFrame = (cb) => {
    queue.push(cb)
    return queue.length
  }
  window.cancelAnimationFrame = () => {}

  // `play` succeeds without playing; `paused` and `ended` report the film's
  // idea of it, so followVideo takes the playhead as its clock.
  const playing = new WeakSet()
  const media = HTMLMediaElement.prototype
  media.play = function () {
    playing.add(this)
    return Promise.resolve()
  }
  media.pause = function () {
    playing.delete(this)
  }
  Object.defineProperty(media, 'paused', {
    get() {
      return !playing.has(this)
    },
  })
  Object.defineProperty(media, 'ended', { get: () => false })

  const settle = () => new Promise((r) => setTimeout(r, 0))
  let frame = 0
  window.__step = async () => {
    const v = document.querySelector('video')
    if (v && playing.has(v)) {
      // Counted from the frame the footage started on, not accumulated, so
      // the seeks do not drift; a hair past the frame's start, so it is
      // never read as the frame before.
      frame += 1
      const at = Math.min(frame / fps + 0.001, v.duration - 0.001)
      v.currentTime = at
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
    } else frame = 0
    now += 1000 / fps
    const due = queue
    queue = []
    for (const cb of due) cb(now)
    // React flushes the frame's state on a task of its own.
    await settle()
    await settle()
    // The Skip button turning into Watch again; it is hidden, so not innerText.
    return document.querySelector('main').textContent.includes('Watch again')
  }
}, FPS)

const page = await context.newPage()
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(new URL('#/intro', site).href)
await page.addStyleTag({
  // Not `visibility`, which the buttons set on themselves as they rise in.
  content: 'main > :not([aria-hidden]) { display: none !important; }',
})
// Polled on a timer: Playwright's default polls on animation frames, which
// are held.
await page.waitForFunction(
  () => {
    const v = document.querySelector('video')
    return v && v.readyState >= 2 && document.fonts.status === 'loaded'
  },
  null,
  { polling: 100 },
)

const ffmpeg = spawn(
  'ffmpeg',
  [
    ...['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-'],
    ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'],
    // The screenshots are full-range JPEG; this is the conversion to the
    // limited range players expect, which -pix_fmt alone does not make.
    ...['-vf', 'scale=out_range=tv,format=yuv420p', '-color_range', 'tv'],
    ...['-movflags', '+faststart', OUT],
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
)
const encoded = new Promise((ok, fail) =>
  ffmpeg.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))),
)

const cdp = await context.newCDPSession(page)
const started = Date.now()
let frames = 0
for (; frames < MAX_FRAMES; frames++) {
  const ended = await page.evaluate(() => window.__step())
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 })
  if (!ffmpeg.stdin.write(Buffer.from(data, 'base64')))
    await new Promise((r) => ffmpeg.stdin.once('drain', r))
  if (ended) break
  if (frames % FPS === 0) process.stdout.write(`\r${frames / FPS}s of film`)
}
ffmpeg.stdin.end()
await encoded
await browser.close()
const took = Math.round((Date.now() - started) / 1000)
console.log(`\r${(frames / FPS).toFixed(1)}s of film in ${took}s → ${OUT}`)
if (frames >= MAX_FRAMES) console.warn('The film never ended; the take was cut at the ceiling.')
