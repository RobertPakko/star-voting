import { motionEase, motionMs, prefersReducedMotion } from './motion'

/**
 * Walking between the questions of a poll, drawn as a row being walked along:
 * the question being left slides out to one side and the question being
 * opened slides in from the other — the next question from the right, the
 * previous one from the left.
 *
 * **What slides is everything after the strip**, which is the question's half
 * of the page and only that. The strip is the poll's, like the heading over
 * it, and stays exactly where it is; see QuestionSkeleton for why that
 * matters. In a card that is the ballot, the list or the card a voter comes
 * back to; on a finished poll it is the tally under the strip. `QuestionStrip`
 * is what calls in here, because it is what knows which question was open and
 * which is opening, and because it is the line the slide is drawn below.
 *
 * **The question being left is a copy.** React has taken it out of the page
 * by the time the next one is drawn, so the strip copies what stands after it
 * as it goes (`noteLeaving`), and the copy is what slides away, over the page
 * and clipped to the card it was in so that it leaves through the card's edge
 * rather than across the page.
 *
 * **The question arriving is one slide, however many times it is redrawn.** A
 * crossing usually puts the question's skeleton up first and the question a
 * moment later, and each is a new strip with new things after it. Each joins
 * the slide where it has got to, started with the time already gone as a
 * negative delay, so the skeleton and the question that replaces it are one
 * movement rather than two.
 */

/**
 * How far a question slides, as a share of the width it slides across: far
 * enough to read as moving along a row rather than as settling into place.
 */
const SLIDE_SHARE = 0.3

/**
 * How soon after a strip leaves a strip arriving counts as the same strip
 * carried across a crossing, rather than a reader arriving at the poll.
 */
const CARRIED_WITHIN_MS = 1000

/** What a strip leaving the screen leaves behind for the one arriving. */
let leaving: {
  poll: string
  question: string
  at: number
  /** The question's half as it stood, copied, and where each piece was. */
  pieces: { copy: HTMLElement; rect: DOMRect }[]
  /** The box it was drawn in, which the copy is clipped to. */
  clip: { left: number; top: number; width: number; height: number }
} | null = null

/** Which question each strip on screen was last drawn for. */
const showing = new WeakMap<HTMLElement, { poll: string; question: string }>()

/** The crossing under way, which arriving pieces join. */
let crossing: {
  poll: string
  to: string
  side: 1 | -1
  at: number
  distance: number
  slid: WeakSet<Element>
} | null = null

/**
 * A strip is leaving the screen: copy what stands after it, in case the strip
 * that replaces it is the same poll's next question. Called from a layout
 * effect's cleanup, which runs while the page being left is still in the
 * document.
 */
export function noteLeaving(strip: HTMLElement | null) {
  leaving = null
  const shown = strip && showing.get(strip)
  if (!strip || !shown || prefersReducedMotion()) return
  const { poll, question } = shown
  const box = clipBoxOf(strip)
  const top = strip.getBoundingClientRect().bottom
  const pieces: { copy: HTMLElement; rect: DOMRect }[] = []
  for (let el = strip.nextElementSibling; el; el = el.nextElementSibling) {
    if (!(el instanceof HTMLElement)) continue
    pieces.push({ copy: el.cloneNode(true) as HTMLElement, rect: el.getBoundingClientRect() })
  }
  leaving = {
    poll,
    question,
    at: performance.now(),
    pieces,
    clip: { left: box.left, top, width: box.width, height: Math.max(0, box.bottom - top) },
  }
}

/**
 * A strip has arrived on `question`, of the poll whose questions are `order`.
 * If it is the same poll's strip carried across from another question, the
 * crossing starts: the question left behind slides away, and `slideAlong`
 * brings the new one in.
 */
export function noteArrival(
  strip: HTMLElement | null,
  poll: string,
  question: string,
  order: string[],
  before: string | null,
) {
  if (strip) showing.set(strip, { poll, question })
  const now = performance.now()
  const left = leaving
  const from =
    before ?? (left?.poll === poll && now - left.at < CARRIED_WITHIN_MS ? left.question : null)
  if (!strip || !from || from === question || prefersReducedMotion()) return
  const a = order.indexOf(from)
  const b = order.indexOf(question)
  if (a < 0 || b < 0) return

  const side = b > a ? 1 : -1
  const distance = Math.round(clipBoxOf(strip).width * SLIDE_SHARE)
  crossing = { poll, to: question, side, at: now, distance, slid: new WeakSet() }

  if (left && left.poll === poll && left.question === from) {
    leaving = null
    slideAway(left, side, distance)
  }
}

/**
 * Brings in whatever stands after the strip that has not yet joined the
 * crossing — on every render while one is under way, since the question's
 * half can be redrawn several times in the course of it.
 */
export function slideAlong(strip: HTMLElement | null, poll: string, question: string) {
  const c = crossing
  if (!strip || !c || c.poll !== poll || c.to !== question) return
  const duration = motionMs('travel')
  const elapsed = performance.now() - c.at
  if (elapsed >= duration) return
  for (let el = strip.nextElementSibling; el; el = el.nextElementSibling) {
    if (c.slid.has(el)) continue
    c.slid.add(el)
    el.animate(
      [
        { transform: `translateX(${c.side * c.distance}px)`, opacity: 0 },
        { opacity: 1, offset: 0.6 },
        { transform: 'none', opacity: 1 },
      ],
      { duration, delay: -elapsed, easing: motionEase() },
    )
  }
}

/** The copy of the question being left, sliding out the other way. */
function slideAway(left: NonNullable<typeof leaving>, side: 1 | -1, distance: number) {
  const { clip } = left
  if (!left.pieces.length || clip.height <= 0) return
  const frame = document.createElement('div')
  frame.setAttribute('aria-hidden', 'true')
  frame.inert = true
  Object.assign(frame.style, {
    position: 'fixed',
    left: `${clip.left}px`,
    top: `${clip.top}px`,
    width: `${clip.width}px`,
    height: `${clip.height}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
    // Under the header, like the page it is part of.
    zIndex: 'calc(var(--app-shell-header-z-index, 100) - 1)',
  } satisfies Partial<CSSStyleDeclaration>)
  const track = document.createElement('div')
  Object.assign(track.style, { position: 'absolute', inset: '0' })
  for (const { copy, rect } of left.pieces) {
    for (const inner of copy.querySelectorAll('[id]')) inner.removeAttribute('id')
    copy.removeAttribute('id')
    Object.assign(copy.style, {
      position: 'absolute',
      left: `${rect.left - clip.left}px`,
      top: `${rect.top - clip.top}px`,
      width: `${rect.width}px`,
      margin: '0',
      boxSizing: 'border-box',
    } satisfies Partial<CSSStyleDeclaration>)
    track.appendChild(copy)
  }
  frame.appendChild(track)
  document.body.appendChild(frame)
  const away = track.animate(
    [
      { transform: 'none', opacity: 1 },
      { opacity: 0, offset: 0.6 },
      { transform: `translateX(${-side * distance}px)`, opacity: 0 },
    ],
    { duration: motionMs('travel'), easing: motionEase(), fill: 'forwards' },
  )
  void away.finished.finally(() => frame.remove()).catch(() => undefined)
}

/**
 * The box a question's half is drawn in, which is what the slide is clipped
 * to: the card holding it where there is one, and otherwise the column the
 * strip stands in.
 */
function clipBoxOf(strip: HTMLElement): DOMRect {
  const box = strip.closest('.mantine-Card-root') ?? strip.parentElement ?? strip
  return box.getBoundingClientRect()
}
