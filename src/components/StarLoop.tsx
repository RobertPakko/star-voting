import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@mantine/hooks'
import classes from './StarLoop.module.css'

/**
 * The home page's picture: a ballot of four options being scored, cleared,
 * and scored again by somebody else, three voters round on an eighteen-second
 * loop. It answers the first thing a newcomer wonders about STAR voting —
 * what does a ballot look like? — before they have read a word.
 *
 * Every frame is a function of `T`, the seconds into the loop, as in the
 * intro: a `requestAnimationFrame` loop advances it, and nothing is animated
 * through CSS. It is drawn at a fixed stage size and scaled to its box, so the
 * choreography's numbers are pixels on that stage and nothing else.
 *
 * It stops while scrolled out of sight, and under reduced motion it is one
 * still frame: the first ballot, filled in.
 */
export function StarLoop() {
  const reducedMotion = useReducedMotion()
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  const [T, setT] = useState(STILL_AT)
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const resize = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / STAGE_W))
    resize.observe(el)
    const seen = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
    seen.observe(el)
    return () => {
      resize.disconnect()
      seen.disconnect()
    }
  }, [])

  // Picks up where it left off after a pause, rather than jumping ahead by
  // however long it was out of sight.
  const elapsed = useRef(0)
  useEffect(() => {
    if (reducedMotion || !inView) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      // Capped, so a tab returning from the background does not skip a ballot.
      elapsed.current += Math.min(0.1, (now - last) / 1000)
      last = now
      setT(elapsed.current % TOTAL)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reducedMotion, inView])

  const still = reducedMotion
  const t = still ? STILL_AT : T
  const b = ballotAt(t)

  return (
    // Decorative: the page's own words say what it shows.
    <div ref={box} className={classes.box} aria-hidden>
      <div
        className={classes.stage}
        style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
      >
        <div
          className={classes.card}
          style={{ left: CARD_X, top: CARD_Y, width: CARD_W, height: ROW_H * 4 }}
        >
          {!still && <Highlight T={t} b={b} />}
          {LABELS.map((label, i) => (
            <Row key={label} T={t} b={b} i={i} />
          ))}
        </div>
      </div>
    </div>
  )
}

const STAGE_W = 1280
const STAGE_H = 600
const CARD_X = 40
const CARD_Y = 0
const CARD_W = 1200
const ROW_H = 150
const PAD = 56
const STAR = 76
const STAR_GAP = 18
/** When the first row is scored, how long until the next, and how long a star takes to pop. */
const ROW_START = 0.5
const ROW_STEP = 0.95
const POP_DUR = 0.34
const STAGGER = 0.1
/** The shimmer that runs across a finished ballot. */
const WAVE_AT = 4.05
const WAVE_DUR = 0.4

/** Each ballot is scored for 4.8 seconds and cleared for 1.2. */
const RATE_FOR = 4.8
const CYCLE = 6
const BALLOTS = [
  { at: 0, scores: [2, 5, 0, 3] },
  { at: CYCLE, scores: [5, 0, 4, 1] },
  { at: CYCLE * 2, scores: [0, 3, 5, 2] },
]
const TOTAL = CYCLE * BALLOTS.length
/** The frame reduced motion shows: every star of the first ballot in, before its shimmer. */
const STILL_AT = 4

const LABELS = ['Option A', 'Option B', 'Option C', 'Option D']
/** The widths of the grey lines standing in for each option's description. */
const DESCRIPTIONS = [340, 260, 380, 300]

type Ballot = (typeof BALLOTS)[number]

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const easeInOutCubic = (t: number) => {
  t = clamp01(t)
  return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1
}
const BACK = 1.70158
const easeOutBack = (t: number) => {
  t = clamp01(t)
  return 1 + (BACK + 1) * Math.pow(t - 1, 3) + BACK * Math.pow(t - 1, 2)
}
const easeInBack = (t: number) => {
  t = clamp01(t)
  return (BACK + 1) * t * t * t - BACK * t * t
}

function ballotAt(T: number): Ballot {
  return T < BALLOTS[1].at ? BALLOTS[0] : T < BALLOTS[2].at ? BALLOTS[1] : BALLOTS[2]
}

/** When row `row` of ballot `b` is scored. */
const clickAt = (b: Ballot, row: number) => b.at + ROW_START + row * ROW_STEP

/** How big star `j` of row `row` is drawn: 0 is not at all, 1 is full size. */
function starScale(T: number, b: Ballot, row: number, j: number): number {
  if (j >= b.scores[row]) return 0
  const tIn = clickAt(b, row) + 0.05 + j * STAGGER
  const tOut = b.at + RATE_FOR + row * 0.07 + (4 - j) * 0.045
  if (T < tOut) {
    let s = easeOutBack((T - tIn) / POP_DUR)
    const w = (T - (b.at + WAVE_AT + (row * 5 + j) * 0.028)) / WAVE_DUR
    if (w > 0 && w < 1) s += 0.14 * Math.sin(Math.PI * w)
    return s
  }
  return Math.max(0, 1 - easeInBack((T - tOut) / 0.3))
}

/** The band behind the row being scored, which steps down the ballot as it goes. */
function Highlight({ T, b }: { T: number; b: Ballot }) {
  let y = 0
  for (let row = 1; row < LABELS.length; row++)
    y += easeInOutCubic((T - (clickAt(b, row) - 0.45)) / 0.4) * ROW_H
  const last = clickAt(b, LABELS.length - 1) + 0.6
  const opacity =
    easeInOutCubic((T - (b.at + 0.15)) / 0.35) * (1 - easeInOutCubic((T - last) / 0.4))
  return <div className={classes.highlight} style={{ top: 8 + y, height: ROW_H - 16, opacity }} />
}

function Row({ T, b, i }: { T: number; b: Ballot; i: number }) {
  return (
    <div
      className={classes.row}
      data-first={i === 0 || undefined}
      style={{ left: PAD, right: PAD, top: i * ROW_H, height: ROW_H }}
    >
      <div className={classes.option}>
        <div className={classes.label}>{LABELS[i]}</div>
        <div className={classes.description} style={{ width: DESCRIPTIONS[i] }} />
      </div>
      <div className={classes.stars} style={{ gap: STAR_GAP }}>
        {[0, 1, 2, 3, 4].map((j) => {
          const s = starScale(T, b, i, j)
          return (
            <div key={j} className={classes.slot} style={{ width: STAR, height: STAR }}>
              <StarGlyph className={classes.empty} />
              {s > 0.001 && <StarGlyph className={classes.filled} scale={s} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A five-pointed star with rounded points, in a 100-unit box. */
const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 ? 0.43 : 1
  const a = -Math.PI / 2 + (i * Math.PI) / 5
  return `${(50 + r * 44 * Math.cos(a)).toFixed(2)},${(53 + r * 44 * Math.sin(a)).toFixed(2)}`
}).join(' ')

function StarGlyph({ className, scale = 1 }: { className: string; scale?: number }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={STAR}
      height={STAR}
      className={className}
      style={scale === 1 ? undefined : { transform: `scale(${scale})` }}
    >
      <polygon points={STAR_POINTS} strokeWidth="9" strokeLinejoin="round" />
    </svg>
  )
}
