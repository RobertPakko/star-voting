import footage from './footage.json'
import sections from './sections.json'

/**
 * The arithmetic the intro film is drawn with: its timeline, its curves, and
 * where things sit in each of its two shapes.
 *
 * Every frame of the film is a function of one number, `T`, the seconds since
 * it started. While the footage plays, the video is the clock — `T` follows
 * its playhead, so a video that stops to buffer holds the film with it — and
 * outside the footage the film runs on its own. Skipping is `T = TOTAL`, and
 * a reader who has asked for less motion starts there. See "The intro" in
 * AGENTS.md.
 */

/** When the footage starts: after the logo has arrived and flown into it. */
export const FOOTAGE = 3.1

/**
 * The recorded sections, each starting where the last ended. Their lengths
 * are the ones the recording was fitted to (scripts/intro/record.mjs), so
 * both videos share this timeline.
 */
export const SECTIONS = sections.reduce<
  { name: string; caption: string; start: number; end: number }[]
>((list, s) => {
  const start = list.length ? list[list.length - 1].end : FOOTAGE
  return [...list, { name: s.name, caption: s.caption, start, end: start + s.seconds }]
}, [])

/** When the footage ends and the logo comes back out of it. */
export const CLOSE = SECTIONS[SECTIONS.length - 1].end
/** The film's length: the closing settled. */
export const TOTAL = CLOSE + 2.6

export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

/**
 * The film is the app in its light scheme whichever scheme the reader is in:
 * it is a recording of the app, not the app, and the page around it takes its
 * background so the letterboxing disappears.
 */
export const COL = {
  text: '#000',
  gray7: '#495057',
  border: '#dee2e6',
  track: '#dee2e6',
  blue: '#228be6',
  chrome: '#f1f3f5',
  bg: '#f8f9fa',
}

/**
 * The film's two shapes, in their own pixels: the opening's logo and
 * wordmark, the closing's (higher on the tall shape, where three stacked
 * buttons and the features have to fit under it), where the calls to action
 * start under the closing wordmark, the caption and progress above the
 * footage, and the screen the footage plays on — a browser window on the wide
 * shape, a phone on the tall one.
 */
export const FILMS = {
  landscape: {
    w: 1920,
    h: 1080,
    logo: { x: 960, y: 400, size: 168 },
    word: { top: 520, size: 92 },
    tag: { top: 650, size: 42 },
    closing: { logo: { x: 960, y: 400, size: 168 }, word: 520 },
    actions: 670,
    progress: { top: 52, width: 720 },
    caption: { top: 84, size: 50 },
    // The video's own 1280×800, scaled to fit under the caption.
    screen: { x: 301, y: 226, w: 1318, h: 824 },
    bar: 46,
  },
  portrait: {
    w: 1080,
    h: 1920,
    logo: { x: 540, y: 820, size: 240 },
    word: { top: 990, size: 110 },
    tag: { top: 1150, size: 52 },
    closing: { logo: { x: 540, y: 470, size: 220 }, word: 620 },
    actions: 790,
    progress: { top: 104, width: 640 },
    caption: { top: 140, size: 58 },
    // A 390×844 phone screen, in a bezel.
    screen: { x: 189, y: 300, w: 702, h: 1519 },
    bar: 0,
  },
} as const
export type FilmShape = keyof typeof FILMS

/** Where the app's own header logo is on the screen, in film pixels. */
export function headerLogo(shape: FilmShape) {
  const { screen } = FILMS[shape]
  const shot = footage[shape]
  const k = screen.w / shot.w
  return {
    x: screen.x + shot.logo.x * k,
    y: screen.y + shot.logo.y * k,
    size: shot.logo.size * k,
  }
}

type Ease = (t: number) => number
export const Easing = {
  linear: ((t) => t) as Ease,
  easeOutCubic: ((t) => (t - 1) ** 3 + 1) as Ease,
  easeInOutCubic: ((t) => (t < 0.5 ? 4 * t ** 3 : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1)) as Ease,
  easeOutBack: ((t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2) as Ease,
}
/** The three curves the film moves on, and no others. */
export const MOTION = {
  enter: Easing.easeOutCubic,
  draw: Easing.easeInOutCubic,
  pop: Easing.easeOutBack,
}

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** `from` before `a`, `to` after `b`, and eased between. */
export function tween(
  T: number,
  a: number,
  b: number,
  from: number,
  to: number,
  ease = MOTION.enter,
) {
  if (T <= a) return from
  if (T >= b) return to
  return from + (to - from) * ease((T - a) / (b - a))
}
export const p01 = (T: number, a: number, b: number, ease?: Ease) => tween(T, a, b, 0, 1, ease)

/** The logo, served from the app's own directory. */
export const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`

/** A recorded video and the still of its first frame, served from public/intro/. */
export const footageSrc = (shape: FilmShape, ext: 'mp4' | 'jpg') =>
  `${import.meta.env.BASE_URL}intro/${shape}.${ext}`
