import { useEffect, useRef, useState } from 'react'

/**
 * The arithmetic the intro film is drawn with: its timeline, its three
 * curves, the poll it tells the story of, and the measuring that points the
 * camera and the cursor at things.
 *
 * Every frame of the film is a pure function of one number, `T`, the seconds
 * since it started — nothing mounts or unmounts as it plays, and nothing is
 * animated by CSS. That is what lets a reader skip to the end, and a reader who
 * has asked for less motion start there: the last frame is simply `T = TOTAL`.
 * See "The intro" in AGENTS.md.
 */

/** Where each part of the film starts, in seconds. */
export const CUES = { Opening: 0, Create: 3, Rate: 8, Decide: 13.5, Close: 19.5 } as const
export type Cues = typeof CUES
/** The film's length: the end of the closing part. */
export const TOTAL = 22

export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

/**
 * The film is the app in its light scheme whichever scheme the reader is in:
 * it is a recording of the app, not the app, and the page around it takes its
 * background so the letterboxing disappears.
 */
export const COL = {
  text: '#000',
  dimmed: '#868e96',
  gray7: '#495057',
  border: '#dee2e6',
  inputBorder: '#ced4da',
  blue: '#228be6',
  blueDark: '#1c7ed6',
  violet: '#7950f2',
  gray6: '#868e96',
  track: '#e9ecef',
  starOff: '#dee2e6',
  star: '#fab005',
  green: '#40c057',
  red: '#fa5252',
  bg: '#f8f9fa',
}
export const BADGE = {
  grape: ['#f3d9fa', '#ae3ec9'],
  cyan: ['#c5f6fa', '#0c8599'],
  lime: ['#e9fac8', '#66a80f'],
  orange: ['#ffe8cc', '#e8590c'],
  green: ['#d3f9d8', '#2f9e44'],
} as const
export type BadgeColor = keyof typeof BADGE

export const OPTIONS = ['Spirited Away', 'Honeyland', 'The Matrix', 'Knives Out']
export const MY_SCORES = [4, 2, 3, 5]
export const TALLY = [
  { name: 'Knives Out', pts: 38, fin: true },
  { name: 'Spirited Away', pts: 33, fin: true },
  { name: 'The Matrix', pts: 27, fin: false },
  { name: 'Honeyland', pts: 14, fin: false },
]
export const VOTERS = ['Alex', 'Sam', 'Priya', 'Jordan', 'Mei', 'Luis', 'Noor', 'Ben', 'Dana']
export const RUNOFF = { a: 'Knives Out', b: 'Spirited Away', pa: 6, pb: 3 }
/** When each of the four rows of stars is clicked: the stars and the cursor both keep to it. */
export const starClicks = (R: number) => [R + 1.15, R + 1.75, R + 2.35, R + 2.95]

/**
 * The film's two shapes, in their own pixels, and how far down each the
 * calls to action start: the space under the closing wordmark, where the
 * opening's tagline stood, is left empty for them.
 */
export const FILMS = {
  landscape: { w: 1920, h: 1080, actions: 670 },
  portrait: { w: 1080, h: 1920, actions: 1180 },
} as const
export type FilmShape = keyof typeof FILMS

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

/** A value moved through a list of keyframes, on the drawing curve. */
export function keyed<K extends string>(
  T: number,
  list: ({ t: number } & Record<K, number>)[],
  prop: K,
) {
  if (T <= list[0].t) return list[0][prop]
  for (let i = 0; i < list.length - 1; i++) {
    const k0 = list[i]
    const k1 = list[i + 1]
    if (T <= k1.t)
      return lerp(
        k0[prop],
        k1[prop],
        MOTION.draw(clamp((T - k0.t) / Math.max(k1.t - k0.t, 1e-6), 0, 1)),
      )
  }
  return list[list.length - 1][prop]
}

/** How much of `text` has been typed by `T`, typing from `a` to `b`. */
export const typed = (T: number, text: string, a: number, b: number) =>
  text.slice(0, Math.round(clamp((T - a) / (b - a), 0, 1) * text.length))

/** A press: up from 0 to 1 and back over `len` seconds from `at`. */
export const press = (T: number, at: number, len = 0.25) =>
  T >= at && T <= at + len ? Math.sin((Math.PI * (T - at)) / len) : 0

export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const rad = (d: number) => (d * Math.PI) / 180
  const x0 = cx + r * Math.cos(rad(a0))
  const y0 = cy - r * Math.sin(rad(a0))
  const x1 = cx + r * Math.cos(rad(a1))
  const y1 = cy - r * Math.sin(rad(a1))
  return `M${cx},${cy} L${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1} Z`
}

export interface Target {
  x: number
  y: number
  w: number
  h: number
}
export type Targets = Record<string, Target>

/**
 * Where every `data-tg` element under `root` sits, in the root's own
 * unscaled coordinates — so it is right whatever the camera and the fit to
 * the window are doing to it when it is asked.
 */
export function measure(root: HTMLElement | null): Targets | null {
  if (!root) return null
  const rr = root.getBoundingClientRect()
  const s = rr.width / root.offsetWidth || 1
  const out: Targets = {}
  root.querySelectorAll<HTMLElement>('[data-tg]').forEach((el) => {
    const r = el.getBoundingClientRect()
    out[el.dataset.tg!] = {
      x: (r.left - rr.left) / s + r.width / s / 2,
      y: (r.top - rr.top) / s + r.height / s / 2,
      w: r.width / s,
      h: r.height / s,
    }
  })
  return out
}

/** A measured target, or a guess at it before the first measurement. */
export const pt = (m: Targets | null, k: string, fx: number, fy: number): Target =>
  m?.[k] ?? { x: fx, y: fy, w: 0, h: 0 }

/** The logo, served from the app's own directory. */
export const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`

/**
 * The measured targets of the two app pages, taken once they are laid out and
 * again once fonts have settled. The pages never change shape as the film
 * plays — only what is typed into them and how opaque they are — so a
 * measurement taken at the start holds for the whole of it.
 */
export function useTargets() {
  const create = useRef<HTMLDivElement>(null)
  const poll = useRef<HTMLDivElement>(null)
  const [targets, setTargets] = useState<{ A: Targets | null; B: Targets | null }>({
    A: null,
    B: null,
  })
  useEffect(() => {
    let live = true
    const run = () => {
      if (live) setTargets({ A: measure(create.current), B: measure(poll.current) })
    }
    run()
    void document.fonts?.ready.then(run)
    const id = setTimeout(run, 900)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [])
  return { create, poll, ...targets }
}
