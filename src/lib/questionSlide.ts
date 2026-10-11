import { motionEase, motionMs, prefersReducedMotion } from './motion'
import { pushIn, pushOut, snapshotOf, timelineNow, type Snapshot } from './carousel'

/**
 * Walking between the questions of a poll, drawn as a row being walked along:
 * the question being left is pushed out to one side and the question being
 * opened pushed in from the other — the next question from the right, the
 * previous one from the left. The push itself is lib/carousel.ts, which the
 * poll list's pages turn with too; this is how a poll page knows one has
 * happened, which way, and what moves.
 *
 * **What slides is everything after the strip and its rule**, which is the
 * question's half of the page and only that. The strip is the poll's, like
 * the heading over it, and so is the rule under it: both stay exactly where
 * they are; see QuestionSkeleton for why that matters. In a card that is the
 * ballot, the list or the card a voter comes back to; on a finished poll it
 * is the tally under the strip. `QuestionStrip` is what calls in here,
 * because it is what knows which question was open and which is opening, and
 * because it is the line the slide is drawn below.
 *
 * **It is a push the whole width of the box, not a nudge.** It moved a third
 * of the way once, with both questions fading across each other in the same
 * place, and that read as the content flickering rather than as a row being
 * walked: two things half-visible in one place is a crossfade whatever the
 * transform says. So the two questions now travel together, edge to edge,
 * each clipped to the box the question is drawn in — the card, or the column
 * — so that one leaves through its edge as the other comes in through the
 * opposite one.
 *
 * **The question being left is a copy.** React has taken it out of the page
 * by the time the next one is drawn, so the strip copies what stands after it
 * as it goes (`noteLeaving`), and the copy is what slides away.
 *
 * **The question arriving is one slide, however many times it is redrawn.** A
 * crossing usually puts the question's skeleton up first and the question a
 * moment later, and each is a new strip with new things after it — and the
 * tally puts its own pieces up when its read lands, without the strip drawing
 * again at all. Each joins the slide where it has got to, started from the
 * moment the crossing began, so the skeleton and the question that replaces it
 * are one movement rather than two.
 */

/**
 * How soon after a strip leaves a strip arriving counts as the same strip
 * carried across a crossing, rather than a reader arriving at the poll.
 */
const CARRIED_WITHIN_MS = 1000

/** What a strip leaving the screen leaves behind for the one arriving. */
let leaving: (Snapshot & { poll: string; question: string; at: number }) | null = null

/** Which question each strip on screen was last drawn for. */
const showing = new WeakMap<HTMLElement, { poll: string; question: string }>()

/** The crossing under way, which arriving pieces join. */
let crossing: {
  poll: string
  from: string
  to: string
  side: 1 | -1
  /** When it began, on the animation timeline, which every piece is started from. */
  start: number
  distance: number
  slid: WeakSet<Element>
} | null = null

/**
 * How the strip's badges looked when it last drew, by question, so that a
 * crossing can fade the old look of the two that change; see `fadeMarks`.
 * Kept here rather than on the strip because the strip is often a new one by
 * the time the crossing is noticed — the card it stands in was replaced.
 */
let looks: { poll: string; question: string; badges: Map<string, HTMLElement> } | null = null

/**
 * The strip has drawn: remember how its badges look now. Called after every
 * render, after anything a crossing needed the previous look for.
 */
export function noteLooks(strip: HTMLElement | null, poll: string, question: string) {
  if (!strip) return
  const badges = new Map<string, HTMLElement>()
  for (const badge of strip.querySelectorAll<HTMLElement>('[data-question-key]'))
    badges.set(badge.dataset.questionKey!, badge.cloneNode(true) as HTMLElement)
  looks = { poll, question, badges }
}

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
  leaving = {
    ...snapshotOf(questionHalf(strip), clipBoxOf(strip), lineOf(strip)),
    poll: shown.poll,
    question: shown.question,
    at: performance.now(),
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
  const distance = Math.round(clipBoxOf(strip).width)
  const start = timelineNow()
  crossing = {
    poll,
    from,
    to: question,
    side,
    start,
    distance,
    slid: new WeakSet(),
  }
  fadeMarks(strip, poll, from, question, start)

  if (left && left.poll === poll && left.question === from) {
    leaving = null
    pushOut(left, side, distance, start)
  }
}

/**
 * Brings in whatever stands after the strip that has not yet joined the
 * crossing — on every render while one is under way, since the question's
 * half can be redrawn several times in the course of it. Each piece is
 * clipped to the box as it comes; see `pushIn`.
 */
export function slideAlong(strip: HTMLElement | null, poll: string, question: string) {
  const c = crossing
  if (!strip || !c || c.poll !== poll || c.to !== question) return
  const duration = motionMs('travel')
  const elapsed = timelineNow() - c.start
  if (elapsed >= duration) return
  const box = clipBoxOf(strip)
  for (const el of questionHalf(strip)) {
    if (c.slid.has(el)) continue
    c.slid.add(el)
    pushIn(el, box, c.side, c.distance, c.start)
  }
  watchForMore(strip, poll, question, duration - elapsed)
}

/**
 * The open question's highlight passes from the badge being left to the badge
 * being opened: the old one loses its fill as the new one gains it, over the
 * length of the slide below. It used to travel along the row as a copy of the
 * badge, which read well on a single line and badly everywhere else — on a
 * narrow screen the badges wrap and stack, and the copy cut diagonally across
 * them. A fade says the same thing without going anywhere, so it is the same
 * whatever shape the row has taken.
 *
 * What fades is the old look of each of the two badges, laid over its new
 * one and taken away: the strip is redrawn by the time a crossing is noticed,
 * and the badge being opened is not even the same element as before (the open
 * question's badge is not a link). Each copy stands on a backing of the
 * surface under the strip, since a light badge is partly see-through and the
 * fill coming in would otherwise show through it from the first frame. The
 * copies are over the page rather than in the strip, so a strip replaced
 * mid-crossing — a skeleton's giving way to the question's — leaves them
 * where they are.
 */
function fadeMarks(strip: HTMLElement, poll: string, from: string, to: string, start: number) {
  const was = looks
  if (!was || was.poll !== poll || was.question !== from) return
  const surface = surfaceOf(strip)
  for (const key of [from, to]) {
    const old = was.badges.get(key)
    const now = strip.querySelector<HTMLElement>(`[data-question-key="${key}"]`)
    if (!old || !now) continue
    const rect = now.getBoundingClientRect()
    const backing = document.createElement('div')
    backing.setAttribute('aria-hidden', 'true')
    backing.inert = true
    Object.assign(backing.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderRadius: getComputedStyle(now).borderRadius,
      // A badge is inline, and inside a block it would sit on a line of text
      // and stand a few pixels off the badge it is meant to cover.
      display: 'flex',
      background: surface,
      pointerEvents: 'none',
      // Over the badge it stands on, under the header.
      zIndex: 'calc(var(--app-shell-header-z-index, 100) - 1)',
    } satisfies Partial<CSSStyleDeclaration>)
    const copy = old.cloneNode(true) as HTMLElement
    copy.removeAttribute('data-question-key')
    for (const inner of copy.querySelectorAll('[id]')) inner.removeAttribute('id')
    Object.assign(copy.style, {
      width: '100%',
      height: '100%',
      maxWidth: 'none',
      margin: '0',
      boxSizing: 'border-box',
    } satisfies Partial<CSSStyleDeclaration>)
    backing.appendChild(copy)
    document.body.appendChild(backing)
    const fade = backing.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: motionMs('travel'),
      easing: motionEase(),
      fill: 'forwards',
    })
    fade.startTime = start
    void fade.finished.finally(() => backing.remove()).catch(() => undefined)
  }
}

/** The colour the strip is drawn on: the nearest background that is not see-through. */
function surfaceOf(el: HTMLElement): string {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color
  }
  return getComputedStyle(document.body).backgroundColor
}

/** The boxes being watched for pieces that arrive mid-crossing. */
const watched = new WeakSet<Element>()

/**
 * Brings in pieces that arrive after the strip last rendered, for the rest of
 * the crossing. The strip calls `slideAlong` when *it* renders, and that is
 * not the only time the question's half changes: `Results` puts its winner
 * banner and its rounds up when its own read lands, as siblings of the strip,
 * without the strip rendering again — and those used to arrive standing still
 * in the middle of a slide. A mutation is delivered before the browser
 * paints, so a piece added this way is moving from its first frame.
 */
function watchForMore(strip: HTMLElement, poll: string, question: string, remaining: number) {
  const box = strip.parentElement
  if (!box || watched.has(box) || remaining <= 0) return
  watched.add(box)
  const observer = new MutationObserver(() => slideAlong(strip, poll, question))
  observer.observe(box, { childList: true })
  window.setTimeout(() => {
    observer.disconnect()
    watched.delete(box)
  }, remaining)
}

/**
 * What stands after the strip and belongs to the question: its siblings,
 * stepping over the rule the strip draws under itself, which is the poll's.
 */
function questionHalf(strip: HTMLElement): HTMLElement[] {
  const half: HTMLElement[] = []
  for (let el = strip.nextElementSibling; el; el = el.nextElementSibling) {
    if (el instanceof HTMLElement && !el.hasAttribute('data-question-rule')) half.push(el)
  }
  return half
}

/**
 * The line the question's half is drawn below: the foot of the rule under the
 * strip, or the foot of the strip itself if there is none.
 */
function lineOf(strip: HTMLElement): number {
  let bottom = strip.getBoundingClientRect().bottom
  let el = strip.nextElementSibling
  while (el?.hasAttribute('data-question-rule')) {
    bottom = el.getBoundingClientRect().bottom
    el = el.nextElementSibling
  }
  return bottom
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
