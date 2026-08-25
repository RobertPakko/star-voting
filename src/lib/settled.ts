/**
 * What the browser remembers about polls that have stopped moving.
 *
 * A poll whose results are out has taken its last vote: the tally, the full
 * ranking, the ballot grid and the elected option are all fixed for good.
 * Everything else in this app is deliberately re-read whenever it changes;
 * these four cannot change, so re-reading them is work that can only ever
 * produce the same answer. The list asks for a winner once instead of once for
 * every vote cast anywhere on and walking back into a finished poll renders it
 * from what is already here rather than from a request.
 *
 * **In memory, for the life of the tab, and no further.** Nothing here
 * touches `localStorage`, and that is the point rather than an omission. A
 * settled poll is settled *unless its creator resets it*; reset deletes
 * every vote and reopens the poll, and the same poll can then finish again
 * with a different answer. Reset is rare and it is announced to nobody
 * (`AGENTS.md`, "Creator controls"), so the honest bound on a wrong answer is
 * a short one:
 *
 *  - A reset **in this tab** clears these entries outright; `CreatorControls`
 *    calls `forgetPoll` so the creator, who is the person most likely to
 *    look immediately afterwards, is never shown the old result.
 *  - A reset **somewhere else** leaves this tab holding a tally the poll no
 *    longer has. Every screen that renders one first reads `poll_status` or
 *    `open_poll_view`, which are never cached, so a poll that has gone back
 *    to taking votes shows its ballot rather than a stale result. What is
 *    left is the narrow case of a poll reset elsewhere *and finished again*
 *    while this tab stayed open; that tab shows the previous answer until it
 *    is reloaded. Persisting any of this would turn that window into a
 *    permanent one, for a saving of one request per poll per session.
 *
 * Nothing cached here is secret. Every entry is a response the server already
 * decided this reader was allowed to have, and it is dropped when the tab is,
 * so a shared computer gives up no more than the page already on screen did.
 */

/** Tallies, rankings and ballot sheets, keyed by which RPC answered and for what. */
const responses = new Map<string, unknown>()

/**
 * Elected options, by poll id. `null` is a real answer; a genuine tie
 * elects nobody, and so does a poll closed before anyone voted which is why
 * this is a Map with a `has` check rather than a lookup that treats a missing
 * entry and an empty one alike. Asking again for a poll that has no winner
 * would be a request repeated forever.
 */
const winners = new Map<string, string | null>()

/**
 * Who wants telling when that map grows.
 *
 * A winner can arrive from either of two places — `poll_winners()`, asked
 * for by a list or a poll page, or the tally a `Results` card fetched for
 * itself — and the badge that displays it is neither of them. Without this,
 * a badge that rendered before the answer landed would keep saying "Results
 * ready" until something else happened to re-render it.
 */
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

function cacheKey(rpc: string, key: string): string {
  return `${rpc}:${key}`
}

/** A settled response, if this tab has already been given one. */
export function recall<T>(rpc: string, key: string): T | undefined {
  return responses.get(cacheKey(rpc, key)) as T | undefined
}

/**
 * Remember a settled response. Only ever called with one: every RPC cached
 * here refuses to answer at all until the results have unlocked, so a
 * response in hand is proof the poll is finished.
 */
export function remember(rpc: string, key: string, value: unknown): void {
  responses.set(cacheKey(rpc, key), value)
}

/** Every poll this tab can already name a winner or name nobody for. */
export function knownWinners(): ReadonlyMap<string, string | null> {
  return winners
}

export function rememberWinner(pollId: string, name: string | null): void {
  // Announcing unconditionally would re-render every badge in the tab each
  // time a page of the poll list re-learns what it already knew.
  if (winners.get(pollId) === name && winners.has(pollId)) return
  winners.set(pollId, name)
  announce()
}

/**
 * Watch the winners map, for `useSyncExternalStore`. Returns the unsubscribe.
 */
export function subscribeWinners(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Forget everything about a poll, because it is no longer the poll that was
 * cached; it was reset, or deleted outright.
 *
 * One id clears the lot. It used to take the share token as well, because an
 * open poll's tally was fetched under the token by the same page that reset
 * it under the id, so clearing one left the other stale in exactly the place
 * the creator was looking. A poll has one identifier now, and the two entries
 * it can hold -- the participant's tally and the open one -- differ by which
 * RPC answered rather than by what was asked about.
 */
export function forgetPoll(pollId: string): void {
  winners.delete(pollId)
  for (const key of responses.keys()) {
    if (key.endsWith(`:${pollId}`)) responses.delete(key)
  }
  // A badge naming an option that this poll no longer elected has to stop
  // saying so now, not on whatever re-render happens next.
  announce()
}
