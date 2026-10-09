import type { ReactNode } from 'react'
import { useTransitionArrival } from '../lib/viewTransition'
import classes from './PollTitleText.module.css'

/**
 * A poll's title as the text inside its heading, which is the part that
 * travels from the list to the poll's page; see lib/viewTransition.ts.
 *
 * On the poll's own page (`landing`) it wears the transition's name for good
 * and says when it has arrived. On a list card it wears nothing until it is
 * pressed: a name has to be unique on the page being left, and only the card
 * that was pressed is going anywhere — so the card names its title at the
 * moment of the press, by the data attribute here.
 *
 * It is the text and not the heading that travels, because the heading is a
 * box as wide as its share of the row and the text is not: moving the box
 * would scale a short title by the width of the space around it, while the
 * text scales by exactly the difference between the two font sizes.
 */
export function PollTitleText({ children, landing }: { children: ReactNode; landing: boolean }) {
  return landing ? (
    <Landing>{children}</Landing>
  ) : (
    <span className={classes.text} data-poll-title>
      {children}
    </span>
  )
}

function Landing({ children }: { children: ReactNode }) {
  useTransitionArrival()
  return <span className={`${classes.text} ${classes.landing}`}>{children}</span>
}
