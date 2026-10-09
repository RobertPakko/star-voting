/**
 * Saying something to a screen reader that the page did not say by changing.
 *
 * A sighted reader sees a vote arrive, a poll close, a page open. A screen
 * reader hears none of it unless focus happens to be on the thing that moved,
 * and on a page that updates itself (see Live updates in AGENTS.md) it almost
 * never is. `Announcer` holds the two live regions that carry these sentences,
 * mounted once at the root so they exist before anything is put in them —
 * which is the condition for a live region to be read at all.
 *
 * **Polite** waits for the reader to finish what they are hearing, and is what
 * nearly everything here is: the page changing, a count moving, a vote going
 * in. **Assertive** interrupts, and is kept for the one kind of news a reader
 * has to act on now — the page has stopped updating.
 *
 * What is announced is a sentence about what changed, never the content
 * itself: the content is on the page, where the reader can go and read it.
 */
export type Politeness = 'polite' | 'assertive'

type Listener = (message: string, politeness: Politeness) => void

const listeners = new Set<Listener>()

export function announce(message: string, politeness: Politeness = 'polite') {
  for (const listener of listeners) listener(message, politeness)
}

/** For `Announcer` alone. */
export function onAnnouncement(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
