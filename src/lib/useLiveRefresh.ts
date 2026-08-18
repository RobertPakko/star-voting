import { useEffect, useRef, useState } from 'react'

/**
 * How often a live page re-reads its poll.
 *
 * Fast enough that a vote arriving mid-conversation shows up while people
 * are still looking at the screen, slow enough that a poll left open on a
 * projector all afternoon is not hammering the database. One shared
 * constant so every live surface in the app moves at the same rate — a
 * roster refreshing twice as fast as the count beside it reads as a bug.
 */
export const LIVE_REFRESH_MS = 5000

/**
 * Re-run `refresh` on an interval for as long as there is something left to
 * watch, and report whether it is currently paused.
 *
 * **Polling, not Supabase Realtime.** Realtime delivers row changes over a
 * websocket, and subscribing to them needs a `SELECT` grant on the table
 * the rows are in. `anon` deliberately has no read grant on any table — an
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
 * A hidden tab stops polling entirely and resumes with an immediate refresh
 * when it comes back — nobody is reading a backgrounded poll, and a laptop
 * lid closed on twenty of them should not keep talking to the database. The
 * `paused` flag is that state, so the page can say so rather than quietly
 * going stale.
 */
export function useLiveRefresh(
  refresh: () => void | Promise<void>,
  {
    /** False once there is nothing left to watch — a settled poll. */
    enabled = true,
    intervalMs = LIVE_REFRESH_MS,
  }: { enabled?: boolean; intervalMs?: number } = {},
): { paused: boolean } {
  const [paused, setPaused] = useState(false)

  // Held in a ref so a caller passing a fresh closure every render restarts
  // nothing: the timer belongs to the poll being watched, not to the
  // identity of the function watching it.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    if (!enabled) {
      setPaused(false)
      return
    }

    let cancelled = false
    let timer: number | undefined

    async function tick() {
      await refreshRef.current()
      // Unmounted, disabled, or backgrounded while the request was in
      // flight -- scheduling another would restart a loop nobody stopped.
      if (cancelled || document.hidden) return
      timer = window.setTimeout(tick, intervalMs)
    }

    function onVisibilityChange() {
      setPaused(document.hidden)
      window.clearTimeout(timer)
      // Whatever arrived while the tab was in the background is exactly
      // what its reader is coming back to look at, so don't make them wait
      // out an interval for it.
      if (!document.hidden) tick()
    }

    setPaused(document.hidden)
    if (!document.hidden) timer = window.setTimeout(tick, intervalMs)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, intervalMs])

  return { paused }
}
