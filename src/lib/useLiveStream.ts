import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { readLedger } from './readLedger'
import { supabase } from './supabase'

/**
 * Minimum gap between reads caused by signals: an idle page reads at once,
 * and a burst shares one trailing read.
 */
const SETTLE_MS = 250

/**
 * Retry after a failed read, a few times. Nothing else would trigger the next
 * read on a quiet poll, so one dropped request could otherwise leave a page
 * stale for good.
 */
const RETRY_MS = 5000
const RETRY_LIMIT = 5

/**
 * Read anyway if subscribing hasn't worked by then, so a network that blocks
 * websockets loses live updates but still shows the poll. Once per page.
 */
const FIRST_READ_MS = 5000

export interface LiveStream {
  /**
   * Read now, through the same queue as signals. A page that has just written
   * uses this rather than reading directly, so its read and its write's own
   * broadcast echo collapse into one. Fire-and-forget: pages render from
   * state the read sets.
   */
  reread: () => void
}

const noop = () => {}

/**
 * Call `onChange` whenever the database broadcasts on `topic`. Messages are
 * empty -- a prompt to re-read through the page's usual RPC, so access rules
 * stay in the database.
 *
 * - The first read happens on SUBSCRIBED, as does every reconnect's catch-up
 *   (Realtime doesn't replay missed messages). `FIRST_READ_MS` is the floor.
 * - A hidden tab drops its socket; coming back re-subscribes and re-reads.
 * - It keeps watching a settled poll, since the creator can reopen it.
 *
 * See "Live updates" in AGENTS.md and readLedger.ts.
 */
export function useLiveStream(
  /** `poll:<id>` or `user:<id>`; null for a page with nothing to watch (the sample). */
  topic: string | null,
  /** Re-read the page. Return `false` if the read failed and is worth retrying. */
  onChange: () => boolean | void | Promise<boolean | void>,
  /**
   * Called on `poll_deleted` instead of reading (a read of a deleted poll
   * fails). If omitted, the event is read like any other -- right for the
   * poll list, whose read just comes back without the card.
   */
  onGone?: (topic: string) => void,
): LiveStream {
  // `reread` keeps one identity; what it reaches changes with the subscription.
  const demand = useRef<() => void>(noop)
  const reread = useCallback(() => demand.current(), [])

  // Refs, so a fresh closure each render doesn't resubscribe.
  const onChangeRef = useRef(onChange)
  const onGoneRef = useRef(onGone)
  useEffect(() => {
    onChangeRef.current = onChange
    onGoneRef.current = onGone
  })

  useEffect(() => {
    // Nothing to subscribe to (the sample), but `reread` must still read, or
    // a vote there would seem to do nothing.
    if (topic === null) {
      demand.current = () => {
        void onChangeRef.current()
      }
      return () => {
        demand.current = noop
      }
    }

    const watching: string = topic
    let cancelled = false
    let channel: RealtimeChannel | null = null
    let settle: number | undefined
    // Reads are chained, never parallel, so a page's own read and its echo queue up.
    let reading = false
    // What the page is owed a read for; see readLedger.ts.
    const ledger = readLedger()
    // Measured between read starts.
    let lastReadAt: number | undefined
    // Set while the tab is hidden, so the deliberate close isn't treated as a failure.
    let paused = false
    let failures = 0
    let everRead = false
    let first: number | undefined

    async function read() {
      if (reading) return
      reading = true
      lastReadAt = Date.now()
      // Taken before sending: a signal arriving mid-read may be about a later commit.
      const mark = ledger.starting()
      let ok = true
      try {
        ok = (await onChangeRef.current()) !== false
      } catch {
        ok = false
      } finally {
        reading = false
      }
      ledger.settled(mark, ok)
      if (cancelled || paused) return

      if (ok) {
        failures = 0
        everRead = true
      } else if (failures < RETRY_LIMIT) {
        failures += 1
        // The ledger has already put the debt back; this retry pays it.
        again(RETRY_MS)
        return
      } else {
        // Give up until the next signal or subscription, rather than looping.
        return
      }

      schedule()
    }

    function again(delay: number) {
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        if (!cancelled) read()
      }, delay)
    }

    /** Read if anything is owed and nothing is in flight, respecting the throttle. */
    function schedule() {
      if (!ledger.owing()) return
      if (reading) return
      const delay = lastReadAt === undefined ? 0 : Math.max(0, lastReadAt + SETTLE_MS - Date.now())
      again(delay)
    }

    /**
     * A read asked for outright (a subscription arriving, or `reread`), which
     * a read already in flight cannot absorb. Forgives past failures.
     */
    function insist() {
      if (cancelled || paused) return
      ledger.insisted()
      failures = 0
      schedule()
    }

    function armFirstRead() {
      if (everRead || first !== undefined) return
      first = window.setTimeout(() => {
        first = undefined
        if (!cancelled && !paused && !everRead) read()
      }, FIRST_READ_MS)
    }

    function open() {
      armFirstRead()
      // Private: only the database may broadcast (`poll_deleted` is acted on
      // without a read, so a public channel would let anyone fake it).
      const opened = supabase.channel(watching, { config: { private: true } })
      channel = opened
      opened.on('broadcast', { event: '*' }, (message) => {
        if (cancelled || paused) return
        if (message.event === 'poll_deleted' && onGoneRef.current) {
          onGoneRef.current(watching)
          return
        }
        ledger.signalled()
        failures = 0
        schedule()
      })
      opened.subscribe((state) => {
        if (cancelled || paused) return
        if (state === 'SUBSCRIBED') {
          window.clearTimeout(first)
          first = undefined
          // Unconditional: nothing sent while disconnected is replayed.
          insist()
        }
      })
    }

    function close() {
      if (channel) supabase.removeChannel(channel)
      channel = null
    }

    function onVisibilityChange() {
      if (document.hidden) {
        paused = true
        window.clearTimeout(settle)
        window.clearTimeout(first)
        first = undefined
        failures = 0
        close()
        return
      }
      if (channel === null) {
        paused = false
        open()
      }
    }

    demand.current = insist

    document.addEventListener('visibilitychange', onVisibilityChange)
    if (!document.hidden) open()

    return () => {
      cancelled = true
      demand.current = noop
      window.clearTimeout(settle)
      window.clearTimeout(first)
      close()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [topic])

  return useMemo(() => ({ reread }), [reread])
}

/** The topic a poll is announced on. */
export function pollTopic(pollId: string): string {
  return `poll:${pollId}`
}

/** The topic a person's poll list is announced on: every change to any poll on it. */
export function userTopic(userId: string): string {
  return `user:${userId}`
}
