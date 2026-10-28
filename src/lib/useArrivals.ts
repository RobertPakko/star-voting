import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Which of `keys` arrived since the last read, so the thing they name can say
 * it is new: a name joining a roster, a badge turning to *Voted*.
 *
 * **Nothing counts as new on the first read.** A roster opened with twelve
 * names in it has not just had twelve people join, and popping every badge on
 * each visit would be the animation saying nothing; see Motion in AGENTS.md.
 * The same goes for a card mounted again.
 *
 * The set holds the last arrivals until the next ones, so a class taken from
 * it stays put through re-reads that change nothing and its animation is not
 * replayed.
 *
 * A layout effect rather than a plain one, so the class is on the element in
 * the same frame it first appears. The animations this drives are keyframes,
 * which start from their own first frame and need nothing painted before them;
 * from a plain effect, the new thing was drawn once at rest and then snapped
 * back to the start of its entrance.
 */
export function useArrivals(keys: string[]): ReadonlySet<string> {
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set())
  // Null until the first read.
  const seen = useRef<Set<string> | null>(null)
  // The keys as one value, so a re-read handing over a new array of the same
  // names is not a change.
  const signature = JSON.stringify(keys)

  useLayoutEffect(() => {
    const now: string[] = JSON.parse(signature)
    const before = seen.current
    seen.current = new Set(now)
    if (!before) return

    const added = now.filter((key) => !before.has(key))
    if (added.length) setArriving(new Set(added))
  }, [signature])

  return arriving
}

/**
 * `keys` in the order they were first seen: what was there on the first read
 * keeps the order it was given in, and anything after that joins the end.
 *
 * For a list sorted by the server, which a re-read would otherwise slot each
 * new entry into the middle of — moving everything after it along, so the
 * arrival is not where the eye goes and the names the reader had already
 * placed are not where they left them. The end of the list is where something
 * new is looked for. A list read afresh (a reload, a later visit) is in the
 * server's order again, which is the order it is meant to be read in.
 *
 * Entries that leave are dropped where they stand.
 */
export function useArrivalOrder(keys: string[]): string[] {
  const [order, setOrder] = useState(keys)
  const present = new Set(keys)
  const kept = order.filter((key) => present.has(key))
  const placed = new Set(kept)
  const settled = [...kept, ...keys.filter((key) => !placed.has(key))]

  // Adjusted during render rather than from an effect, so the list is never
  // drawn once in the server's order first.
  if (settled.length !== order.length || settled.some((key, i) => key !== order[i])) {
    setOrder(settled)
  }
  return settled
}
