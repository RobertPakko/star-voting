import { useState } from 'react'

/**
 * Whether the results of question `id` came out while this page was showing
 * it — the reading went from sealed to out with the reader looking — rather
 * than being out already when they opened it.
 *
 * Only the first is a moment: watching a poll finish is being there when it
 * is decided, and the tally is allowed to mark it (see `live` on Results).
 * Opening a poll that finished last week is reading a result, and a card that
 * made a fuss every time it was opened would be making it for nothing.
 *
 * Held per question, and kept once true for as long as that question is on
 * screen, so the tally drawing again — a re-read, a crossing back — does not
 * take the mark away mid-animation or play it a second time on a card that
 * remounts. Crossing to another question is a different question; coming back
 * to one whose results came out a minute ago is a page showing a result.
 *
 * State derived from the last render's props, which React allows for exactly
 * this: comparing with what was seen before needs no effect, and so no frame
 * in which the tally is drawn without the mark and then redrawn with it.
 */
export function useResultsLanding(id: string | undefined, out: boolean): boolean {
  const [seen, setSeen] = useState({ id, out })
  const [landed, setLanded] = useState<string | undefined>(undefined)
  if (seen.id !== id || seen.out !== out) {
    setSeen({ id, out })
    if (seen.id === id && !seen.out && out) setLanded(id)
    else if (seen.id !== id) setLanded(undefined)
  }
  return !!id && landed === id
}
