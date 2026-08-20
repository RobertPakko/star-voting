import { useEffect, useRef } from 'react'

/**
 * How often a live page re-reads its poll.
 *
 * Fast enough that a vote arriving mid-conversation shows up while people
 * are still looking at the screen, slow enough that a poll left open on a
 * projector all afternoon is not hammering the database. One shared
 * constant so every live surface in the app moves at the same rate; a
 * roster refreshing twice as fast as the count beside it reads as a bug.
 */
export const LIVE_REFRESH_MS = 5000

/**
 * How many refreshes a page may run through before it stops and waits to be
 * asked again; thirty minutes' worth.
 *
 * A tab nobody has touched since lunch should not still be polling at
 * teatime, and left uncapped that is exactly what an app whose pages update
 * themselves does. Any sign of a reader resets the budget in full (see
 * `wake` below), so this only ever bites a page that has sat untouched in
 * the foreground for half an hour and the first click or scroll on one
 * brings it back with an immediate refresh.
 */
export const LIVE_REFRESH_LIMIT = (30 * 60 * 1000) / LIVE_REFRESH_MS

/**
 * Signs that somebody is actually in front of the page. Deliberately not
 * mousemove: a cursor crossing a window on its way somewhere else is not a
 * reader, and it fires hundreds of times while doing it.
 */
const WAKE_EVENTS = ['pointerdown', 'keydown', 'scroll'] as const
const WAKE_OPTIONS = { passive: true, capture: true } as const

/**
 * Re-run `refresh` on an interval for as long as there is something left to
 * watch and somebody left to watch it.
 *
 * **Polling, not Supabase Realtime.** Realtime delivers row changes over a
 * websocket, and subscribing to them needs a `SELECT` grant on the table
 * the rows are in. `anon` deliberately has no read grant on any table; an
 * open poll's voters reach their poll entirely through the `open_poll_*`
 * functions, which is what keeps a share token from also being a key to the
 * rest of the schema (see AGENTS.md). Realtime would therefore mean either
 * opening those tables to `anon` and re-deriving every access rule as an
 * RLS policy, or streaming to signed-in voters only and polling for
 * everyone else anyway. Re-calling the same RPCs the pages already use
 * keeps one access path and one set of rules, at a cost of one small
 * request every few seconds.
 *
 * Refreshes are chained rather than fired on a fixed interval: the next one
 * is scheduled after the last has come back, so a slow response delays the
 * following request instead of stacking up behind it.
 *
 * Three things stop the loop, and all three restart it the moment the page
 * is worth updating again:
 *
 *  - a hidden tab, because nobody is reading a backgrounded poll and a
 *    laptop lid closed on twenty of them should not keep talking to the
 *    database. Coming back refreshes immediately rather than waiting out an
 *    interval; whatever arrived meanwhile is what its reader is coming
 *    back to look at;
 *  - the refresh budget above, for a tab left open and forgotten;
 *  - `enabled` going false, for a poll that has taken its last vote.
 *
 * There is no indicator: a page that updates itself demonstrates that by
 * updating itself, and a dot claiming it does is one more thing to read.
 */
export function useLiveRefresh(
  refresh: () => void | Promise<void>,
  {
    /** False once there is nothing left to watch; a settled poll. */
    enabled = true,
    intervalMs = LIVE_REFRESH_MS,
    limit = LIVE_REFRESH_LIMIT,
  }: { enabled?: boolean; intervalMs?: number; limit?: number } = {},
): void {
  // Held in a ref so a caller passing a fresh closure every render restarts
  // nothing: the timer belongs to the poll being watched, not to the
  // identity of the function watching it.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let timer: number | undefined
    // Refreshes run since the reader last gave any sign of being there.
    let spent = 0
    // Whether a refresh is already coming: a timer waiting, or a request in
    // flight. What stops a click from firing one on top of another.
    let pending = false

    function schedule() {
      if (spent >= limit) {
        pending = false
        return
      }
      pending = true
      timer = window.setTimeout(tick, intervalMs)
    }

    async function tick() {
      spent += 1
      await refreshRef.current()
      // Unmounted, disabled, or backgrounded while the request was in
      // flight; scheduling another would restart a loop nobody stopped.
      if (cancelled) return
      if (document.hidden) {
        pending = false
        return
      }
      schedule()
    }

    // Somebody is there: the budget starts again, and a page that had
    // stopped picks up where it left off with a refresh straight away
    // rather than a stale first impression.
    function wake() {
      spent = 0
      if (cancelled || pending || document.hidden) return
      tick()
    }

    function onVisibilityChange() {
      if (document.hidden) {
        window.clearTimeout(timer)
        pending = false
        return
      }
      wake()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    for (const type of WAKE_EVENTS) window.addEventListener(type, wake, WAKE_OPTIONS)
    if (!document.hidden) schedule()

    return () => {
      cancelled = true
      pending = false
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      for (const type of WAKE_EVENTS) window.removeEventListener(type, wake, WAKE_OPTIONS)
    }
  }, [enabled, intervalMs, limit])
}
