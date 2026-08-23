import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'

/**
 * The minimum time between reads caused by live signals.
 *
 * A signal reads immediately when the page is idle, then further signals in
 * the interval share one trailing read. A creator pasting in six invitees
 * therefore gets a prompt first update without six reads of the same poll.
 */
const SETTLE_MS = 250

/**
 * How long a page will sit with no working subscription before it says so.
 *
 * A socket that drops and comes straight back is the ordinary weather of a
 * laptop moving between networks, and a warning that flashes up every time is
 * worse than no warning at all. This is the pause that tells a blip apart
 * from a page that is genuinely no longer being told anything.
 */
const GRACE_MS = 8000

/**
 * How long to wait before asking again after a read that failed, and how many
 * times to bother.
 *
 * Polling used to cover this by accident: a read that lost a race with a
 * flaky connection was simply followed by another one five seconds later, and
 * nobody had to think about it. Nothing follows a failed read now — the next
 * one comes when somebody votes, and on the last vote of a poll that is
 * never. Without this, one dropped request at the wrong moment leaves a page
 * showing a ballot for a poll that has already closed.
 *
 * A read failing while the socket is up is the unusual case, because the
 * common kinds of trouble take the socket with them and reconnecting already
 * re-reads. So this is short and gives up quickly: past that, the honest
 * thing is to stop guessing and tell the reader.
 */
const RETRY_MS = 3000
const RETRY_LIMIT = 4

/**
 * How long a page waits for a subscription before reading anyway.
 *
 * The first read happens on subscribing, which is what keeps it to one read
 * instead of two. Taken literally that makes the websocket load-bearing for
 * the page existing at all: on a network that blocks websockets outright —
 * the corporate proxy, the hotel captive portal — nothing would ever
 * subscribe, so nothing would ever read, and the poll would sit behind its
 * loading skeleton for good. Losing live updates on such a network is a
 * decision this app has made; losing the poll is not.
 *
 * So this is the one read that does not wait to be invited, and it happens
 * once per page rather than on a repeat: it is a floor under the page, not a
 * timer creeping back in. A healthy socket subscribes in a fraction of this
 * and cancels it on the way past.
 */
const FIRST_READ_MS = 3000

/**
 * Whether the page in front of the reader is still being told about changes.
 *
 * `connecting` covers both the first moments and any later gap short enough
 * not to be worth mentioning; only `offline` is worth putting on screen.
 */
export type LiveStatus = 'connecting' | 'live' | 'offline'

/**
 * Re-read `onChange` whenever the database says one of `topics` moved.
 *
 * **Streaming, not polling.** Pages used to re-read themselves every few
 * seconds. They now hold a websocket and re-read when told to; the telling
 * half is `broadcast_poll_change()` and the triggers around it, in the
 * squashed baseline and `0035_broadcast_polls_to_watchers.sql`.
 *
 * **The message is a knock on the door, not the news.** Every broadcast is
 * empty. It says a poll changed, and this hook answers by calling the same
 * RPC the page would have called anyway — so the database functions remain
 * the only way anything is read, and every rule about who may see what stays
 * where it already was. That is what lets an open poll's voters, who have no
 * read grant on any table, be told about a vote at all: they are told
 * nothing, and then they ask.
 *
 * **The first read happens on subscribe, not on mount.** A page that loaded
 * itself and then subscribed would either read twice or leave a gap between
 * the two where a vote could slip through unseen. Waiting for the
 * subscription costs a handshake before anything appears and buys both
 * problems away. It is also what makes a reconnect self-healing: Realtime
 * does not replay what it sent while a socket was down, but rejoining a
 * channel reports `SUBSCRIBED` again, and every one of those is a fresh read.
 * A laptop that slept through four votes wakes up and asks.
 *
 * **Except that a page never waits on the socket forever.** Read literally,
 * the rule above makes the websocket load-bearing for the poll appearing at
 * all, and a network that blocks websockets would leave a permanent loading
 * skeleton. `FIRST_READ_MS` is the floor under that: one read, once, if
 * subscribing has not worked by then. Live updates are what such a network
 * costs; the poll is not.
 *
 * **A hidden tab holds no socket.** Nobody is reading a backgrounded poll,
 * and twenty of them behind a closed lid should not each hold a connection
 * open. Coming back re-subscribes, which re-reads — so returning to a tab
 * shows what arrived while it was away, rather than what was there when it
 * left.
 *
 * Returns what to tell the reader; see `LiveConnectionNotice`.
 */
export function useLiveStream(
  topics: readonly string[],
  /**
   * Re-read whatever this page shows. Returning `false` means the read did
   * not work and is worth trying again shortly; anything else, including
   * nothing at all, means it did.
   */
  onChange: () => boolean | void | Promise<boolean | void>,
  { enabled = true }: { enabled?: boolean } = {},
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting')

  // Held in a ref so a caller passing a fresh closure every render resubscribes
  // nothing: the channels belong to the poll being watched, not to the identity
  // of the function watching it.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  // `topics` is a fresh array on every render, so the effect depends on its
  // contents rather than its identity. A space is a safe separator because
  // every topic is a fixed prefix and a uuid or hex token, so two different
  // lists cannot collapse into the same key.
  const key = topics.join(' ')

  useEffect(() => {
    if (!enabled || key === '') return

    let cancelled = false
    let channels: RealtimeChannel[] = []
    let settle: number | undefined
    let grace: number | undefined
    // Whether a read is in flight, and whether something arrived while it
    // was. Reads are chained rather than run in parallel, so a slow
    // connection spaces them out instead of stacking them up.
    let reading = false
    let missed = false
    // The throttle is measured between read starts, so a slow read does not
    // add another delay before the trailing read.
    let lastReadAt: number | undefined
    // Whether at least one channel is currently carrying messages.
    let subscribed = false
    // Whether the channels were let go on purpose, because the tab went
    // behind something. Closing them reports itself back through the same
    // callback a channel that broke would, and a tab put away deliberately
    // must not come back to a warning about it.
    let paused = false
    // Reads that have failed in a row. Cleared by the first one that works,
    // so a page that is fine apart from one dropped request forgets about it.
    let failures = 0
    // Whether this page has anything on it yet, which decides whether the
    // floor below is still needed.
    let everRead = false
    let first: number | undefined

    async function read() {
      if (reading) {
        missed = true
        return
      }
      reading = true
      lastReadAt = Date.now()
      let ok = true
      try {
        ok = (await onChangeRef.current()) !== false
      } catch {
        ok = false
      } finally {
        reading = false
      }
      // A read that was in flight when the tab went away still finishes, and
      // what it found is kept; what it must not do is report on a page
      // nobody is looking at, or line up another.
      if (cancelled || paused) return

      if (ok) {
        failures = 0
        everRead = true
        // Puts the page back after a run of failed reads gave up. Only worth
        // saying while there is still something listening, or the next
        // signal would have nowhere to arrive.
        if (subscribed) setStatus('live')
      } else if (failures < RETRY_LIMIT) {
        failures += 1
        again(RETRY_MS)
        return
      } else {
        // Out of patience. The socket may well be fine, but nothing this
        // page shows can be trusted to be current, which is the thing the
        // notice actually says.
        setStatus('offline')
      }

      if (missed) {
        missed = false
        soon()
      }
    }

    function again(delay: number) {
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        if (!cancelled) read()
      }, delay)
    }

    function soon() {
      failures = 0
      if (reading) {
        missed = true
        return
      }
      const delay = lastReadAt === undefined ? 0 : Math.max(0, lastReadAt + SETTLE_MS - Date.now())
      again(delay)
    }

    // Start counting towards telling the reader that this page has gone
    // quiet. Cleared by the next subscription that works.
    function armGrace() {
      if (grace !== undefined) return
      grace = window.setTimeout(() => {
        grace = undefined
        if (!cancelled) setStatus('offline')
      }, GRACE_MS)
    }

    // The floor under a page that may never manage to subscribe. Armed only
    // while there is nothing on screen: once a read has landed, a socket that
    // will not connect costs live updates and says so, which is the bargain.
    function armFirstRead() {
      if (everRead || first !== undefined) return
      first = window.setTimeout(() => {
        first = undefined
        if (!cancelled && !paused && !everRead) read()
      }, FIRST_READ_MS)
    }

    function open() {
      armGrace()
      armFirstRead()
      channels = key.split(' ').map((topic) => {
        const channel = supabase.channel(topic)
        // Every event on the topic, because a poll change and an invite
        // arrive under different names and both mean the same thing here:
        // ask again.
        channel.on('broadcast', { event: '*' }, () => {
          if (!cancelled && !paused) soon()
        })
        channel.subscribe((state) => {
          if (cancelled || paused) return
          if (state === 'SUBSCRIBED') {
            window.clearTimeout(grace)
            grace = undefined
            // The subscription arrived in time, so the floor is not needed:
            // the read below is the one this page was waiting for.
            window.clearTimeout(first)
            first = undefined
            subscribed = true
            setStatus('live')
            // Both the first read and the catch-up after a reconnect. Every
            // SUBSCRIBED reads, unconditionally: a redundant read is a wasted
            // round trip, where a suppressed one is a page left showing votes
            // that have since been overtaken.
            //
            // That is affordable because every page subscribes to exactly one
            // topic. A caller passing several would get one read per channel
            // -- and worse, any that landed while the first was still in
            // flight would each queue a trailing read behind it, because
            // `missed` cannot tell a genuine signal from a wave of channels
            // arriving. The poll list used to do exactly that and cost three
            // reads to draw itself once; the fix was to give it a topic it
            // could name before its first read, not to second-guess this.
            soon()
          } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
            subscribed = false
            armGrace()
          }
        })
        return channel
      })
    }

    function close() {
      for (const channel of channels) supabase.removeChannel(channel)
      channels = []
    }

    function onVisibilityChange() {
      if (document.hidden) {
        // Set before closing, not after: letting the channels go reports
        // itself back as `CLOSED`, which is indistinguishable from one that
        // broke and would otherwise start the clock on a warning that fires
        // while nobody is even looking.
        paused = true
        window.clearTimeout(settle)
        window.clearTimeout(grace)
        window.clearTimeout(first)
        grace = undefined
        first = undefined
        subscribed = false
        failures = 0
        close()
        // Not `offline`: nothing is wrong, and there is nobody in front of
        // the page to tell anyway.
        setStatus('connecting')
        return
      }
      if (channels.length === 0) {
        paused = false
        open()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    if (!document.hidden) open()

    return () => {
      cancelled = true
      window.clearTimeout(settle)
      window.clearTimeout(grace)
      window.clearTimeout(first)
      close()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [key, enabled])

  return status
}

/** The topic a poll is announced on, for a page that knows the poll's id. */
export function pollTopic(pollId: string): string {
  return `poll:${pollId}`
}

/**
 * The topic a poll is announced on, for a page that holds only a share link.
 *
 * The same poll is announced twice, under its id and under its token, because
 * somebody arriving on `/p/:token` does not learn the poll's id until they
 * have read it once — and reading it once is what this exists to avoid having
 * to do before subscribing.
 */
export function shareTopic(token: string): string {
  return `poll:${token}`
}

/**
 * The topic a person's own poll list is announced on.
 *
 * Everything that moves on that list arrives here: a vote in any poll on it, a
 * poll closing, and an invite to one they have never seen. It is the whole of
 * what `PollList` subscribes to, because it is the one topic the page can name
 * before it has read anything — which is what keeps that read to one.
 */
export function userTopic(userId: string): string {
  return `user:${userId}`
}
