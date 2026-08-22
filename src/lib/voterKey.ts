/**
 * Per-poll random id kept in localStorage, sent with every open-poll call.
 *
 * It exists so the app can say "your vote is in", so a refresh or a
 * double-click can't cast a second ballot, and so a voter can be handed their
 * own ballot back to change it. It is explicitly NOT a vote guard: clearing
 * site data or opening another browser mints a new key and buys another vote.
 * That is the accepted trade of open polls; see the warning shown at creation
 * time.
 *
 * Handing the ballot back is what makes this a secret rather than only a
 * label. Holding the key used to prove nothing but "this browser voted";
 * `open_poll_view` now returns that ballot's scores to whoever presents it,
 * so on a shared browser the next person sees the previous one's ballot
 * filled in rather than a bare "your vote is in". It stays in that one
 * browser's `localStorage` and is never sent anywhere but the poll's own
 * RPCs, and an open poll already promises less than an invite poll does —
 * but it is a promise that changed, not one that was always this.
 *
 * Scoped per poll rather than one id per browser, so it can't be used to
 * link the same person's votes across different polls.
 */

const memoryKeys = new Map<string, string>()

function randomKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function voterKeyFor(token: string): string {
  const storageKey = `star-voting:voter-key:${token}`

  try {
    const existing = localStorage.getItem(storageKey)
    if (existing) return existing
    const created = randomKey()
    localStorage.setItem(storageKey, created)
    return created
  } catch {
    // Private browsing, or storage disabled entirely. Fall back to a
    // per-tab key: double-submit protection still works for this session,
    // and "you already voted" just won't survive a reload.
    let fallback = memoryKeys.get(storageKey)
    if (!fallback) {
      fallback = randomKey()
      memoryKeys.set(storageKey, fallback)
    }
    return fallback
  }
}
