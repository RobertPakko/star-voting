import { motionEase, motionMs, prefersReducedMotion } from './motion'

/**
 * A poll's heading flying between its card on the list and the top of its own
 * page — out when a poll is opened from the list, and back when the reader
 * returns to it with the page's own back control.
 *
 * **What it is for.** The list is ten cards of badges that look alike, and the
 * page that replaces it is the answer to *is this the poll I tapped?* — so the
 * heading the reader pressed travels to where the page's heading sits: the
 * title growing into the page's title, and the state badge, the description,
 * who made it and the row of tags each moving to their own places beside it.
 * It is also what the page waits behind: a poll is opened onto a blank page
 * with only its heading in the air, while the poll is read underneath. If the
 * read is back by the time the heading lands, the page arrives whole and no
 * skeleton is ever drawn; if not, the skeleton arrives instead. See
 * `PollPage` in App.tsx.
 *
 * **How.** Each part of the heading is copied from the heading it is flying
 * to, drawn over the page fixed to the viewport exactly where that part is,
 * and animated backwards from where it started (the FLIP technique: first,
 * last, invert, play). The page underneath is never frozen and never
 * pictured, so it can render, read and respond the whole time; the copies are
 * only ever on top of it. It is driven by hand with the Web Animations API,
 * which is what lets the page know the moment it lands.
 *
 * The parts are found by the marks `PollHeading` puts on them, so the two
 * ends need only both be a `PollHeading`: the card's compact one and the
 * page's — or the skeleton's, which draws the real heading from what the card
 * handed over. A part only one end has (a description the card was not told
 * about) does not fly; it arrives with the page.
 *
 * It replaced a View Transition, which could not do the second half of the
 * job: a view transition freezes the page until the new one is ready and
 * animates between two pictures of it, so nothing can load *during* one.
 *
 * Skipped for a reader who has asked for less motion, who gets the plain
 * navigation, and where there is no `Element.animate`.
 */

/** The parts of a heading that fly, each to its own counterpart. */
const PARTS = ['title', 'state', 'description', 'creator', 'tags'] as const
type Part = (typeof PARTS)[number]

/**
 * Finds a part of a heading by the shape `PollHeading` draws: the title and
 * the two lines under it are marked, the state badge is the end of the title's
 * row, and the tags are the heading's last row.
 */
function partOf(heading: Element, part: Part): HTMLElement | null {
  switch (part) {
    case 'state':
      return heading.querySelector('[data-heading-row]')?.lastElementChild as HTMLElement | null
    case 'tags':
      return heading.lastElementChild as HTMLElement | null
    default:
      return heading.querySelector<HTMLElement>(`[data-heading-part="${part}"]`)
  }
}

/** The heading a page or a card draws; see `PollHeading`. */
export function headingIn(scope: ParentNode, kind: 'card' | 'page'): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-heading="${kind}"]`)
}

type Origin = { left: number; top: number; fontSize: number }

export type Flight = {
  /** Which way: onto a poll's page, or back onto its card on the list. */
  to: 'poll' | 'list'
  /** The poll being opened, or the list card being returned to. */
  id: string
  /** Where each part was when it was pressed, in viewport pixels. */
  from: Partial<Record<Part, Origin>>
  at: number
  /**
   * Launched by a press that asked for this journey — a card, or the page's
   * own way back — rather than noticed on the way out of a page; see
   * `departing`.
   */
  deliberate: boolean
}

/**
 * How long a launched flight waits to be picked up. A navigation commits in
 * well under this, and a flight nobody claimed — a press the router never
 * acted on — must not fire later on some unrelated arrival.
 */
const FRESH_MS = 1000

let pending: Flight | null = null

/**
 * Takes off from `from`, the heading the reader just pressed, if the reader
 * has not asked for less motion. The page being opened picks it up.
 */
export function launchFlight(
  to: Flight['to'],
  id: string,
  from: Element | null,
  deliberate = true,
) {
  pending = null
  if (!from || prefersReducedMotion() || typeof from.animate !== 'function') return
  // A heading scrolled out of sight has nowhere on screen to take off from,
  // and a title arriving from beyond the edge of the window reads as
  // something falling in rather than as the thing just pressed. The page
  // arrives as it would have without one.
  const title = partOf(from, 'title')?.getBoundingClientRect()
  if (!title || title.bottom <= 0 || title.top >= window.innerHeight) return
  const origins: Flight['from'] = {}
  for (const part of PARTS) {
    const el = partOf(from, part)
    if (!el) continue
    const rect = el.getBoundingClientRect()
    origins[part] = { left: rect.left, top: rect.top, fontSize: fontSizeOf(el) }
  }
  pending = { to, id, from: origins, at: performance.now(), deliberate }
}

/**
 * A page is going because the address moved on its own — the browser's back
 * or forward button, or a link that is not one of the app's flights — and
 * where it is going is a page this heading could fly to. Launch the flight
 * the page being opened will look for, unless one is already on its way (a
 * press launched it before the address moved), or the browser has drawn a
 * transition of its own for this step, as a swipe back on a phone does: two
 * animations of one step is one too many.
 *
 * Called from a layout effect's cleanup, which runs while the page being left
 * is still in the document and the heading can still be measured. It runs
 * after the page being opened has rendered, which is why both ends look for
 * their flight in a layout effect rather than while rendering.
 */
export function departing(to: Flight['to'], id: string, from: Element | null) {
  if (peekFlight(to) || browserAnimated()) return
  launchFlight(to, id, from, false)
}

/**
 * The flight back onto the list, if the list should take it: one the page's
 * own way back launched, or one the browser's back button did. A list reached
 * any other way — the wordmark — is somebody asking for the list as it is
 * now, and draws it fresh rather than as it was left (see lib/listCache.ts),
 * so there is no card waiting where the heading would land.
 */
export function returnFlight(navigationType: string): Flight | null {
  const flight = peekFlight('list')
  return flight && (flight.deliberate || navigationType === 'POP') ? flight : null
}

/**
 * The step the browser drew a transition for, if the last one was. A swipe
 * back on a phone slides the page over by itself, and says so on the
 * `popstate` it fires; this listens from the moment the app loads, ahead of
 * the router's own listener, so the answer is in before any page is replaced.
 */
let uaAnimatedAt = -Infinity
if (typeof window !== 'undefined')
  window.addEventListener('popstate', (event) => {
    if ((event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition)
      uaAnimatedAt = performance.now()
  })

function browserAnimated(): boolean {
  return performance.now() - uaAnimatedAt < FRESH_MS
}

/**
 * Stops the rise a page arrives with (`Reveal`), on every page wrapping
 * `el`, where a flight is landing there instead. The page arrives by the
 * flight; and a page still rising when the flight measures where to land is
 * a landing aimed a few pixels low, which shows as the heading settling and
 * then stepping up into place. The fades are left alone — a fade moves
 * nothing.
 */
export function stillEntrances(el: Element) {
  for (let box = el.closest('[data-reveal="rise"]'); box;) {
    for (const animation of box.getAnimations()) animation.cancel()
    box = box.parentElement?.closest('[data-reveal="rise"]') ?? null
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
  /** Resolves when every part has reached the place it was sent to. */
  arrived: Promise<void>
  /**
   * Hands over to the heading that is really there now — moving each part
   * onto its counterpart first, if that is not quite where the flight was
   * aimed — waits `hold` for whatever is fading in underneath, and fades the
   * copies away.
   */
  settle(onto: Element | null, hold: number): Promise<void>
  /** Gone at once, wherever it is. */
  cancel(): void
}

type Ghost = { part: Part; el: HTMLElement; at: DOMRect; size: number }

/**
 * Flies `flight` onto `target`, a heading that has to be laid out — visible or
 * not — at the place it will be when the flight lands. Its parts are hidden
 * until the copies reach them.
 */
export function fly(flight: Flight, target: Element): FlightRun {
  const ghosts: Ghost[] = []
  const hidden: HTMLElement[] = []
  const travels: Animation[] = []

  for (const part of PARTS) {
    const from = flight.from[part]
    const el = partOf(target, part)
    if (!from || !el) continue
    const at = el.getBoundingClientRect()
    const size = fontSizeOf(el)
    const ghost = copyOf(el, at)
    document.body.appendChild(ghost)
    ghosts.push({ part, el: ghost, at, size })
    el.style.visibility = 'hidden'
    hidden.push(el)
    travels.push(
      ghost.animate(
        [
          {
            transform: `translate(${from.left - at.left}px, ${from.top - at.top}px) scale(${from.fontSize / size})`,
          },
          { transform: 'none' },
        ],
        { duration: motionMs('travel'), easing: motionEase(), fill: 'forwards' },
      ),
    )
  }

  const reveal = () => {
    for (const el of hidden) el.style.visibility = ''
    hidden.length = 0
  }

  let gone = false
  const cancel = () => {
    gone = true
    reveal()
    for (const travel of travels) travel.cancel()
    for (const ghost of ghosts) ghost.el.remove()
  }

  return {
    // `finished` rejects when an animation is cancelled, which is the page
    // going away mid-flight and nothing anybody needs to hear about.
    arrived: Promise.all(travels.map((travel) => travel.finished)).then(
      () => reveal(),
      () => new Promise<void>(() => {}),
    ),
    async settle(onto, hold) {
      if (gone) return
      for (const ghost of ghosts) {
        const there = onto && partOf(onto, ghost.part)?.getBoundingClientRect()
        if (!there) continue
        const scale = fontSizeOf(partOf(onto, ghost.part)!) / ghost.size
        if (
          Math.abs(there.left - ghost.at.left) > 0.5 ||
          Math.abs(there.top - ghost.at.top) > 0.5 ||
          Math.abs(scale - 1) > 0.01
        )
          ghost.el.animate(
            [
              { transform: 'none' },
              {
                transform: `translate(${there.left - ghost.at.left}px, ${there.top - ghost.at.top}px) scale(${scale})`,
              },
            ],
            { duration: motionMs('base'), easing: motionEase(), fill: 'forwards' },
          )
      }
      if (hold > 0) await wait(hold)
      if (gone) return
      // Over the real heading, which is fully in by now: where the two agree
      // this changes nothing on screen, and where they differ — a count that
      // moved, a title wrapping beside a wider badge — it is a cross-fade
      // rather than a jump.
      await Promise.all(
        ghosts.map((ghost) =>
          ghost.el
            .animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: motionMs(onto ? 'fast' : 'base'),
              easing: motionEase(),
              fill: 'forwards',
            })
            .finished.catch(() => undefined),
        ),
      )
      cancel()
    },
    cancel,
  }
}

/**
 * A copy of one part, fixed over the page exactly where the part is. What the
 * part inherited from the heading around it — its font and colour — is
 * written onto the copy, since the copy is drawn outside that heading; and
 * anything sized against the heading (a badge's share of the row) is pinned
 * to the size it actually is.
 */
function copyOf(el: HTMLElement, at: DOMRect): HTMLElement {
  const style = getComputedStyle(el)
  const ghost = el.cloneNode(true) as HTMLElement
  ghost.removeAttribute('id')
  for (const inner of ghost.querySelectorAll('[id]')) inner.removeAttribute('id')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${at.left}px`,
    top: `${at.top}px`,
    // A pixel to spare, so the copy wraps where the original does rather than
    // a word earlier on a rounding error.
    width: `${Math.ceil(at.width) + 1}px`,
    maxWidth: 'none',
    minWidth: '0',
    margin: '0',
    boxSizing: 'border-box',
    visibility: 'visible',
    // Under the header rather than over it: a heading scrolled up behind the
    // header flies out from behind it, as the page would have it.
    zIndex: 'calc(var(--app-shell-header-z-index, 100) - 1)',
    pointerEvents: 'none',
    transformOrigin: '0 0',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textTransform: style.textTransform,
    color: style.color,
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>)
  return ghost
}

function fontSizeOf(el: Element): number {
  return parseFloat(getComputedStyle(el).fontSize) || 16
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
