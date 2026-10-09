import type { ReactNode } from 'react'
import classes from './PollTitleText.module.css'

/**
 * A poll's title as the text inside its heading, which is the part of the
 * heading that grows as it flies between the list and the poll's page; see
 * lib/headingFlight.ts.
 *
 * It is the text and not the heading that flies, because the heading is a box
 * as wide as its share of the row and the text is not: flying the box would
 * scale a short title by the width of the space around it, while the text
 * scales by exactly the difference between the two font sizes.
 */
export function PollTitleText({ children }: { children: ReactNode }) {
  return (
    <span className={classes.text} data-heading-part="title">
      {children}
    </span>
  )
}
