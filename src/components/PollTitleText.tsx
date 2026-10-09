import type { ReactNode } from 'react'
import classes from './PollTitleText.module.css'

/**
 * A poll's title as the text inside its heading, which is the part that
 * flies between the list and the poll's page; see lib/titleFlight.ts.
 *
 * Marked for the flight to find: `data-poll-title` on a list card, where the
 * flight takes off from and lands back on, and `data-title-landing` on the
 * poll's own page, where it lands — the page's heading, or the skeleton's
 * standing in for it, which is drawn in the same place for that reason.
 *
 * It is the text and not the heading that flies, because the heading is a box
 * as wide as its share of the row and the text is not: flying the box would
 * scale a short title by the width of the space around it, while the text
 * scales by exactly the difference between the two font sizes.
 */
export function PollTitleText({ children, landing }: { children: ReactNode; landing: boolean }) {
  return landing ? (
    <span className={classes.text} data-title-landing>
      {children}
    </span>
  ) : (
    <span className={classes.text} data-poll-title>
      {children}
    </span>
  )
}
