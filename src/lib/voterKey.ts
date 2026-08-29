/**
 * Per-poll random id kept in localStorage, sent with every open-poll call.
 *
 * It exists so the app can say "your vote is in", so a refresh or a
 * double-click cannot cast a second ballot, and so a voter can be handed their
 * own ballot back to change it. It is explicitly **not** a vote guard:
 * clearing site data or opening another browser mints a new key and buys
 * another vote. That is the accepted trade of open polls; see the warning
 * shown at creation time.
 *
 * Handing the ballot back is what makes this a secret rather than only a
 * label. `open_poll_view` returns that ballot's scores to whoever presents the
 * key, so on a shared browser the next person sees the previous one's ballot
 * filled in. It stays in that one browser's `localStorage` and is never sent
 * anywhere but the poll's own RPCs.
 *
 * **Scoped per poll** rather than one id per browser, so it cannot be used to
 * link the same person's votes across polls — nor, since a question of a
 * multi-question poll is a poll of its own, across the questions of one.
 */

const memoryKeys = new Map<string, string>()

function randomKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function storageKeyFor(pollId: string): string {
  return `star-voting:voter-key:${pollId}`
}

/**
 * The key this browser is already holding for a poll, or null if it has none.
 *
 * Minting one is right at the moment a ballot is cast, or a poll is read as an
 * open poll — by then it is known to be a poll this browser might vote in.
 * `poll_page` is asked before that, and it is the request that *establishes*
 * which kind of poll the address leads to, so minting on the way in would
 * leave a key behind for every invite poll an account ever opened. A browser
 * that has voted is holding its key already, and one that is not holding a key
 * has not voted — the same answer a freshly minted key would have produced.
 */
export function heldVoterKeyFor(pollId: string): string | null {
  const storageKey = storageKeyFor(pollId)
  try {
    return localStorage.getItem(storageKey) ?? memoryKeys.get(storageKey) ?? null
  } catch {
    return memoryKeys.get(storageKey) ?? null
  }
}

export function voterKeyFor(pollId: string): string {
  const storageKey = storageKeyFor(pollId)

  try {
    const existing = localStorage.getItem(storageKey)
    if (existing) return existing
    const created = randomKey()
    localStorage.setItem(storageKey, created)
    return created
  } catch {
    // Private browsing, or storage disabled entirely. Fall back to a per-tab
    // key: double-submit protection still works for this session, and "you
    // already voted" just won't survive a reload.
    let fallback = memoryKeys.get(storageKey)
    if (!fallback) {
      fallback = randomKey()
      memoryKeys.set(storageKey, fallback)
    }
    return fallback
  }
}
