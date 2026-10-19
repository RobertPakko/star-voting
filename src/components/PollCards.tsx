import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Stack } from '@mantine/core'
import { pushIn, pushOut, snapshotOf, still, timelineNow, type Snapshot } from '../lib/carousel'
import { motionEase, motionMs, prefersReducedMotion } from '../lib/motion'

/**
 * Which page of which list a set of cards is. The parent keys this component
 * by it, so a page turn is a new set of cards rather than the same set
 * changing — which is what lets the two below tell a turn from a reshuffle.
 */
export interface ListPage {
  /** The removed view rather than the list itself. */
  removed: boolean
  page: number
}

/**
 * How soon after one page of cards goes a page arriving counts as the same
 * list turned, rather than the reader coming back to it from somewhere else.
 */
const TURNED_WITHIN_MS = 1000

/** The page of cards that has just gone, copied as it went. */
let left: (Snapshot & ListPage & { at: number }) | null = null

/**
 * The cards of one page of the poll list, and the two ways they move.
 *
 * **A page turn pushes the row along**, the same push the questions of a poll
 * turn with (lib/carousel.ts): the page being left goes out through one side
 * and the page being opened comes in through the other — forward from the
 * right, back from the left. Without it a page turn was the list blinking into
 * a different list in place, at the bottom of a page the reader had just been
 * scrolled away from. The page being left is copied as it unmounts and put in
 * the page beside the new cards, so it goes up with the list as the list goes
 * to its top, and slides under the floating pager rather than across it.
 *
 * **Within a page, cards move rather than jump.** A poll taken off the list
 * used to vanish and every card under it jump up into the gap, and a poll
 * arriving pushed everything down by a card's height between two frames —
 * which, on a list that updates itself, could happen while the reader's
 * pointer was on its way to a card. Now each card that has moved is drawn
 * from where it was to where it is (FLIP: measured at every commit, and
 * animated back from the difference), a card that has arrived fades in where
 * it lands, and a card that has gone fades out where it stood, so the gap
 * closes rather than snapping shut. Measured against the document, so the
 * reader scrolling between two commits is not mistaken for every card moving.
 *
 * The card that fades out is a copy taken while it was dimmed on its way off
 * (`data-leaving`, which the list sets between the press and the read), since
 * by the time it is gone there is nothing left to fade. One that goes without
 * being pressed here — deleted, or removed on another device — has no copy
 * and simply goes, while the cards under it close up.
 */
export function PollCards({ turn, children }: { turn: ListPage; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, { top: number; left: number }>())
  const ghosts = useRef(new Map<string, { copy: HTMLElement; rect: DOMRect }>())
  const page = useRef(turn)

  // The turn: arriving, push the last page out and this one in; going, copy
  // this one for whatever replaces it.
  useLayoutEffect(() => {
    const el = root.current
    const here = page.current
    if (!el) return
    const now = performance.now()
    const last = left
    left = null
    if (
      last &&
      last.removed === here.removed &&
      last.page !== here.page &&
      now - last.at < TURNED_WITHIN_MS &&
      !prefersReducedMotion()
    ) {
      const side = here.page > last.page ? 1 : -1
      const box = el.getBoundingClientRect()
      const start = timelineNow()
      // In the page beside the cards, so it passes under the pager.
      pushOut(last, side, box.width, start, { after: el })
      pushIn(el, box, side, box.width, start)
    }
    return () => {
      if (!el.isConnected) return
      left = { ...snapshotOf([el], el.getBoundingClientRect()), ...here, at: performance.now() }
    }
  }, [])

  // Within the page: every commit, measure the cards against the last commit
  // and draw whatever moved from where it was.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const cards = [...el.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.pollCard,
    )
    const before = positions.current
    const now = new Map<string, { top: number; left: number }>()
    for (const card of cards) {
      const rect = card.getBoundingClientRect()
      now.set(card.dataset.pollCard!, { top: rect.top + window.scrollY, left: rect.left })
    }
    positions.current = now

    // Only a card arriving or going moves the others. With the same cards in
    // the same order, a difference in where they stand is the page around them
    // having moved since the last commit — the window resized, a banner above
    // closed, a font loaded — and drawing that as the cards sliding would be
    // every card twitching at the next unrelated render.
    const same =
      before.size === now.size &&
      [...before.keys()].every((id, i) => cards[i]?.dataset.pollCard === id)

    if (before.size > 0 && !same && !prefersReducedMotion()) {
      const duration = motionMs('base')
      const easing = motionEase()
      for (const card of cards) {
        const id = card.dataset.pollCard!
        const was = before.get(id)
        const is = now.get(id)!
        if (!was) {
          card.animate(
            [
              { opacity: 0, transform: 'scale(0.98)' },
              { opacity: 1, transform: 'none' },
            ],
            {
              duration,
              easing,
            },
          )
        } else if (Math.abs(was.top - is.top) > 1) {
          card.animate(
            [{ transform: `translateY(${was.top - is.top}px)` }, { transform: 'none' }],
            {
              duration,
              easing,
            },
          )
        }
      }
      for (const id of before.keys()) {
        if (now.has(id)) continue
        const ghost = ghosts.current.get(id)
        if (ghost) fadeAway(ghost.copy, ghost.rect, duration, easing)
      }
    }

    // Copies of the cards on their way off, for when they have gone. Taken
    // fresh at every commit while they are dimmed, so the copy is the card as
    // it last looked.
    const leaving = new Map<string, { copy: HTMLElement; rect: DOMRect }>()
    for (const card of cards) {
      if (card.dataset.leaving === undefined) continue
      const rect = card.getBoundingClientRect()
      leaving.set(card.dataset.pollCard!, {
        copy: still(card.cloneNode(true) as HTMLElement),
        rect: new DOMRect(
          rect.left + window.scrollX,
          rect.top + window.scrollY,
          rect.width,
          rect.height,
        ),
      })
    }
    ghosts.current = leaving
  })

  return (
    <Stack ref={root} gap="md">
      {children}
    </Stack>
  )
}

/** A card that has gone, fading where it stood. */
function fadeAway(copy: HTMLElement, rect: DOMRect, duration: number, easing: string) {
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  for (const inner of copy.querySelectorAll('[id]')) inner.removeAttribute('id')
  Object.assign(copy.style, {
    position: 'absolute',
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: 'calc(var(--app-shell-header-z-index, 100) - 1)',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(copy)
  const out = copy.animate([{ transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], {
    duration,
    easing,
    fill: 'forwards',
  })
  void out.finished.finally(() => copy.remove()).catch(() => undefined)
}
