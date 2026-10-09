import { useLayoutEffect } from 'react'
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom'

/**
 * A poll's title carried from the card it was opened from to the top of its
 * own page, with the View Transitions API.
 *
 * The one place in the app this is done, and the reason it earns its motion
 * (see Motion in AGENTS.md) is the question it answers: *is this the poll I
 * tapped?* The list is ten cards of badges that look alike; the page that
 * replaces it says so by moving the title the reader just pressed into the
 * place where the page's own title sits. Everything else does what it already
 * did: the page fades in through `Reveal` exactly as before, and only the
 * title travels.
 *
 * **It is driven by hand, because the router cannot do it here.** React
 * Router's `viewTransition` works only under a data router, and this app uses
 * `HashRouter`, which also commits every navigation inside `startTransition` —
 * so flushing the route synchronously inside the transition's callback, the
 * usual trick, does nothing. Instead the callback returns a promise that the
 * destination resolves from a layout effect the moment its title is in the
 * DOM (`useTransitionArrival`), which is the moment the browser should take
 * its picture of the new page. A timeout stands behind it, so a navigation
 * that never draws a title cannot hold the page frozen.
 *
 * Skipped where the browser has no `startViewTransition` (Firefox, older
 * Safari) and for a reader who has asked for less motion, who get the plain
 * navigation they always got.
 */

/** The name the travelling title wears; see `PollTitleText`. */
export const POLL_TITLE_TRANSITION = 'poll-title'

/** Longer than any page takes to commit, shorter than a wait anybody notices. */
const ARRIVAL_TIMEOUT_MS = 300

let arrived: (() => void) | null = null

export function navigateWithTransition(
  navigate: NavigateFunction,
  to: To,
  options?: NavigateOptions,
  /** Named for the transition in the old page, if it should travel. */
  from?: HTMLElement | null,
) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (typeof document.startViewTransition !== 'function' || reduced) {
    navigate(to, options)
    return
  }
  if (from) from.style.viewTransitionName = POLL_TITLE_TRANSITION
  document.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(done, ARRIVAL_TIMEOUT_MS)
        function done() {
          clearTimeout(timer)
          if (arrived === done) arrived = null
          resolve()
        }
        arrived = done
        navigate(to, options)
      }),
  )
}

/**
 * Called by whatever draws the travelling title on the page being opened: the
 * new page is ready to be pictured once it is in the DOM.
 */
export function useTransitionArrival() {
  useLayoutEffect(() => {
    arrived?.()
  }, [])
}
