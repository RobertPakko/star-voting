import { motionEase, motionMs } from './motion'

/**
 * The push the app turns a row of things with: what is on screen leaves
 * through one edge of the box it is drawn in as what replaces it comes in
 * through the other, the two edge to edge, the way a carousel turns.
 *
 * Two callers, and they are the two places the app walks along a row: the
 * questions of a poll (lib/questionSlide.ts) and the pages of the poll list
 * (PollList). What differs between them is how each knows a turn has
 * happened and which way; this is what they share, which is the movement.
 *
 * **What leaves is a copy.** By the time the new content is drawn React has
 * taken the old out of the page, so the caller copies it as it goes
 * (`snapshotOf`) and the copy is what slides away (`pushOut`), over the page
 * and clipped to the box it was in.
 *
 * **What arrives is the real thing**, pushed in with `pushIn` and clipped to
 * the same box as it comes, so that it is not seen crossing the empty page
 * beside a column on its way in.
 *
 * **Everything in one turn starts from one moment** on the animation
 * timeline (`timelineNow`), however late a piece joins — a skeleton giving way
 * to what it stood in for, a card that put itself up when its own read landed
 * — so the row moves as one thing whatever order it was drawn in.
 */

/**
 * How far past the box a clip reaches up and down. The push is horizontal, so
 * only the sides are clipped; the top and bottom are left well clear so a
 * shadow or a focus ring is not shaved off on the way in.
 */
const CLEAR = 4000

/** What was on screen, copied as it went, and the box it was drawn in. */
export interface Snapshot {
  pieces: { copy: HTMLElement; rect: DOMRect }[]
  clip: { left: number; top: number; width: number; height: number }
}

/**
 * Now, on the clock animations run on. Measured with `performance.now()`
 * instead, a piece joining a turn late was placed by a clock the animations do
 * not run on, and drifted from its neighbours by however far the two had come
 * apart.
 */
export function timelineNow(): number {
  const t = document.timeline.currentTime
  return typeof t === 'number' ? t : performance.now()
}

/**
 * Copies `elements` as they stand, to be pushed away once they are gone.
 * `box` is what the copy is clipped to, from `top` down if the top of it is
 * something that stays.
 */
export function snapshotOf(elements: HTMLElement[], box: DOMRect, top = box.top): Snapshot {
  return {
    pieces: elements.map((el) => ({
      copy: still(el.cloneNode(true) as HTMLElement),
      rect: el.getBoundingClientRect(),
    })),
    clip: { left: box.left, top, width: box.width, height: Math.max(0, box.bottom - top) },
  }
}

/**
 * A copy with its CSS animations already over. A cloned element is a new
 * element, so every animation its classes name starts again from the top: a
 * winner card that landed a minute ago settled and rang a second time on its
 * way out, and an entrance played over a copy that was leaving. Put far into
 * the past rather than switched off, because some of them hold where they end
 * — the count's old words rolled out of the pill are only gone while theirs
 * is held — and switching those off would put back what they took away.
 */
export function still(copy: HTMLElement): HTMLElement {
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')])
    el.style.animationDelay = '-1000s'
  return copy
}

/**
 * The copy of what was on screen, leaving through the edge on the side away
 * from `side` (1 for a step forward, -1 for one back).
 *
 * `scrolls` pins it to the document rather than the window, for a turn that
 * scrolls the page at the same time — the poll list goes to its top as its
 * page changes — so the copy goes up with the page instead of hanging where
 * the window was.
 *
 * `after` puts the copy in the page, straight after that element, rather than
 * over the whole of it on `document.body` — for a row with something floating
 * over it that the copy must pass *under*. On the body the copy is above every
 * part of the page, and the poll list's pager, sticky at the foot of the
 * screen, had the old page sliding across it. In the page it shares the
 * pager's stacking context and sits under it by z-index. Placed by measuring
 * where it lands rather than by the document's coordinates, since an ancestor
 * holding a transform (`Reveal`'s entrance) is what it is positioned against
 * there; and being in the page, it scrolls with it, so `scrolls` is implied.
 */
export function pushOut(
  snap: Snapshot,
  side: 1 | -1,
  distance: number,
  start: number,
  { scrolls = false, after }: { scrolls?: boolean; after?: HTMLElement } = {},
) {
  const { clip } = snap
  if (!snap.pieces.length || clip.height <= 0) return
  const frame = document.createElement('div')
  frame.setAttribute('aria-hidden', 'true')
  frame.inert = true
  Object.assign(frame.style, {
    position: scrolls || after ? 'absolute' : 'fixed',
    left: `${clip.left + (scrolls ? window.scrollX : 0)}px`,
    top: `${clip.top + (scrolls ? window.scrollY : 0)}px`,
    width: `${clip.width}px`,
    height: `${clip.height}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
    // Under the header, like the page it is part of; in the page, above the
    // cards and under whatever floats over them.
    zIndex: after ? '1' : 'calc(var(--app-shell-header-z-index, 100) - 1)',
  } satisfies Partial<CSSStyleDeclaration>)
  const track = document.createElement('div')
  Object.assign(track.style, { position: 'absolute', inset: '0' })
  for (const { copy, rect } of snap.pieces) {
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
  if (after) {
    Object.assign(frame.style, { left: '0px', top: '0px' })
    after.after(frame)
    const origin = frame.getBoundingClientRect()
    frame.style.left = `${clip.left - origin.left}px`
    frame.style.top = `${clip.top - origin.top}px`
  } else {
    document.body.appendChild(frame)
  }
  // Near enough opaque for most of the way, so it is seen to leave rather than
  // to fade where it stood. It does go in the end, because what arrives may be
  // shorter, and a copy still at full strength below it would be drawn over
  // whatever the page puts there.
  const away = track.animate(
    [
      { transform: 'none', opacity: 1 },
      { opacity: 0.85, offset: 0.6 },
      { transform: `translateX(${-side * distance}px)`, opacity: 0 },
    ],
    { duration: motionMs('travel'), easing: motionEase(), fill: 'forwards' },
  )
  away.startTime = start
  void away.finished.finally(() => frame.remove()).catch(() => undefined)
}

/**
 * `el` coming in from the edge on `side`, clipped to `box` as it comes.
 *
 * A card clips what moves inside it by itself, and a column does not, so the
 * clip is the piece's own: it travels with it, and is drawn back exactly as
 * far as the piece is pushed forward — one inset on the side it enters by,
 * interpolated on the same curve as the transform, which keeps the edge it
 * enters through standing still. It is gone when the push ends.
 */
export function pushIn(
  el: HTMLElement,
  box: DOMRect,
  side: 1 | -1,
  distance: number,
  start: number,
) {
  const rect = el.getBoundingClientRect()
  // How far the box reaches past the piece on each side, as the inset that
  // widens the clip to it: a card's padding, or nothing in a column.
  const left = rect.left - box.left
  const right = box.right - rect.right
  const shift = side * distance
  const inset = (r: number, l: number) => `inset(-${CLEAR}px ${r}px -${CLEAR}px ${l}px)`
  const slide = el.animate(
    [
      {
        transform: `translateX(${shift}px)`,
        clipPath: side > 0 ? inset(shift - right, -left) : inset(-right, -shift - left),
        opacity: 0,
      },
      { opacity: 1, offset: 0.35 },
      { transform: 'none', clipPath: inset(-right, -left), opacity: 1 },
    ],
    { duration: motionMs('travel'), easing: motionEase() },
  )
  slide.startTime = start
}
