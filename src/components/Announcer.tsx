import { useEffect, useState } from 'react'
import { VisuallyHidden } from '@mantine/core'
import { onAnnouncement, type Politeness } from '../lib/announce'

/**
 * The live regions `announce()` writes to; see lib/announce.ts.
 *
 * Mounted once, at the root, outside the router: a region added to the page at
 * the moment it is given something to say is read by some screen readers and
 * not others, so these are there from the first paint and only their text
 * changes.
 *
 * Two details make a region say what it is given every time:
 *
 *  - **It is emptied first and filled on the next frame.** A region given the
 *    text it already holds has not changed, and says nothing — so the second
 *    "your vote is in" in a row would be silent.
 *  - **It is emptied again a few seconds later.** A sentence left in a region
 *    is still there when a reader walks the page with the virtual cursor, and
 *    reads as part of whatever page they are on by then.
 */
const CLEAR_AFTER_MS = 7000

export function Announcer() {
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')

  useEffect(() => {
    const timers: number[] = []
    const unsubscribe = onAnnouncement((message, politeness) => {
      const set = politeness === 'assertive' ? setAssertive : setPolite
      set('')
      timers.push(
        window.setTimeout(() => {
          set(message)
          timers.push(
            window.setTimeout(
              () => set((current) => (current === message ? '' : current)),
              CLEAR_AFTER_MS,
            ),
          )
        }, 50),
      )
    })
    return () => {
      unsubscribe()
      timers.forEach((t) => clearTimeout(t))
    }
  }, [])

  return (
    <VisuallyHidden>
      <Region politeness="polite" text={polite} />
      <Region politeness="assertive" text={assertive} />
    </VisuallyHidden>
  )
}

function Region({ politeness, text }: { politeness: Politeness; text: string }) {
  return (
    <div
      role={politeness === 'assertive' ? 'alert' : 'status'}
      aria-live={politeness}
      aria-atomic="true"
      data-announcer={politeness}
    >
      {text}
    </div>
  )
}
