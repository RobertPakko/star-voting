import { motionEase, motionMs, prefersReducedMotion } from './motion'

/**
 * A poll's title flying between its card on the list and the top of its own
 * page — out when a poll is opened from the list, and back when the reader
 * returns to it with the page's own back control.
 *
 * **What it is for.** The list is ten cards of badges that look alike, and the
 * page that replaces it is the answer to *is this the poll I tapped?* — so the
 * title the reader pressed travels to where the page's title sits. It is also
 * what the page waits behind: a poll is opened onto a blank page with only
 * this title moving across it, while the poll is read underneath. If the read
 * is back by the time the title lands, the page arrives whole and no skeleton
 * is ever drawn; if not, the skeleton arrives instead. See `PollPage` in
 * App.tsx.
 *
 * **How.** A copy of the title is drawn over the page, fixed to the viewport,
 * styled exactly like the title it is flying to and placed where that title
 * is, and then animated backwards from where it started (the FLIP technique:
 * first, last, invert, play). The page underneath is never frozen and never
 * pictured, so it can render, read and respond the whole time the title is in
 * the air; the copy is only ever on top of it. It is driven by hand with the
 * Web Animations API, which is what lets the page know the moment it lands.
 *
 * It replaced a View Transition, which could not do the second half of the
 * job: a view transition freezes the page until the new one is ready and
 * animates between two pictures of it, so nothing can load *during* one.
 *
 * Skipped for a reader who has asked for less motion, who gets the plain
 * navigation, and where there is no `Element.animate`.
 */

export type Flight = {
  /** Which way: onto a poll's page, or back onto its card on the list. */
  to: 'poll' | 'list'
  /** The poll being opened, or the list card being returned to. */
  id: string
  title: string
  /** Where the title was when it was pressed, in viewport pixels. */
  from: { left: number; top: number; fontSize: number }
  at: number
}

/**
 * How long a launched flight waits to be picked up. A navigation commits in
 * well under this, and a flight nobody claimed — a press the router never
 * acted on — must not fire later on some unrelated arrival.
 */
const FRESH_MS = 1000

let pending: Flight | null = null

/**
 * Takes off from `from`, the title the reader just pressed, if the reader has
 * not asked for less motion. The page being opened picks it up.
 */
export function launchFlight(to: Flight['to'], id: string, from: HTMLElement | null) {
  pending = null
  if (!from || prefersReducedMotion() || typeof from.animate !== 'function') return
  const rect = from.getBoundingClientRect()
  pending = {
    to,
    id,
    title: from.textContent ?? '',
    from: { left: rect.left, top: rect.top, fontSize: fontSizeOf(from) },
    at: performance.now(),
  }
}

/**
 * The flight on its way to `to` — and to `id`, where given — if there is one.
 * Reading it changes nothing, so a render may ask; `landFlight` is what
 * claims it.
 */
export function peekFlight(to: Flight['to'], id?: string): Flight | null {
  if (!pending || pending.to !== to || (id !== undefined && pending.id !== id)) return null
  if (performance.now() - pending.at > FRESH_MS) return null
  return pending
}

/** Done with: the next arrival is an ordinary one. */
export function landFlight(flight: Flight) {
  if (pending === flight) pending = null
}

export type FlightRun = {
  /** Resolves when the title reaches the place it was sent to. */
  arrived: Promise<void>
  /**
   * Hands over to the title that is really there now — moving onto it first
   * if it is not quite where the flight was aimed — waits `hold` for whatever
   * is fading in underneath, and fades the copy away.
   */
  settle(onto: Element | null, hold: number): Promise<void>
  /** Gone at once, wherever it is. */
  cancel(): void
}

/**
 * Flies `flight`'s title onto `target`, which has to be laid out — visible or
 * not — at the place it will be when the flight lands.
 */
export function fly(flight: Flight, target: Element): FlightRun {
  const to = target.getBoundingClientRect()
  const style = getComputedStyle(target)
  const ghost = document.createElement('span')
  ghost.textContent = flight.title
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${to.left}px`,
    top: `${to.top}px`,
    // A pixel to spare, so the copy wraps where the title does rather than a
    // word earlier on a rounding error.
    width: `${Math.ceil(to.width) + 1}px`,
    margin: '0',
    padding: '0',
    display: 'block',
    // Under the header rather than over it: a title scrolled up behind the
    // header flies out from behind it, as the page would have it.
    zIndex: 'calc(var(--app-shell-header-z-index, 100) - 1)',
    pointerEvents: 'none',
    transformOrigin: '0 0',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    color: style.color,
    wordBreak: 'break-word',
    whiteSpace: 'normal',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(ghost)

  const size = fontSizeOf(target)
  const start = `translate(${flight.from.left - to.left}px, ${flight.from.top - to.top}px) scale(${flight.from.fontSize / size})`
  const travel = ghost.animate([{ transform: start }, { transform: 'none' }], {
    duration: motionMs('travel'),
    easing: motionEase(),
    fill: 'forwards',
  })

  let gone = false
  const cancel = () => {
    gone = true
    travel.cancel()
    ghost.remove()
  }

  return {
    // `finished` rejects when the animation is cancelled, which is the page
    // going away mid-flight and nothing anybody needs to hear about.
    arrived: travel.finished.then(
      () => undefined,
      () => new Promise<void>(() => {}),
    ),
    async settle(onto, hold) {
      if (gone) return
      if (onto) {
        const there = onto.getBoundingClientRect()
        const scale = fontSizeOf(onto) / size
        if (
          Math.abs(there.left - to.left) > 0.5 ||
          Math.abs(there.top - to.top) > 0.5 ||
          Math.abs(scale - 1) > 0.01
        )
          ghost.animate(
            [
              { transform: 'none' },
              {
                transform: `translate(${there.left - to.left}px, ${there.top - to.top}px) scale(${scale})`,
              },
            ],
            { duration: motionMs('base'), easing: motionEase(), fill: 'forwards' },
          )
      }
      if (hold > 0) await wait(hold)
      if (gone) return
      // Over the real title, which is fully in by now: where the two agree
      // this changes nothing on screen, and where they wrap differently it is
      // a cross-fade rather than a jump.
      const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: motionMs(onto ? 'fast' : 'base'),
        easing: motionEase(),
        fill: 'forwards',
      })
      await fade.finished.catch(() => undefined)
      cancel()
    },
    cancel,
  }
}

function fontSizeOf(el: Element): number {
  return parseFloat(getComputedStyle(el).fontSize) || 16
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
