import type { ReactNode } from 'react'
import classes from './Reveal.module.css'

/** Which way the content comes in from. */
export type RevealFrom = 'below' | 'left' | 'right'

/**
 * Content arriving, wherever content arrives.
 *
 * Four things in the app appear in place of something else — a skeleton
 * filling in, a page replacing the page before it, one question of a poll
 * giving way to the next, and the winner card once there is a winner — and
 * all four were an instant swap. A swap is the one thing a reader cannot
 * follow: something is in a place, and then something else is, and nothing
 * on screen said which of the two just happened.
 *
 * So they share an entrance, for the reason `BallotCard` and `PollHeading`
 * are each one component: four copies of a fade are four things to keep in
 * step, and motion drifts even faster than wording because nobody can diff
 * it. What differs between the four is the direction and the key, and both
 * are the caller's.
 *
 * **It runs on mount, which makes the `key` the whole of the mechanism.** An
 * entrance is not a thing to trigger; it is what happens when an element is
 * new. Give it a key that changes when the content is genuinely a different
 * thing — the question being read, the page being opened — and it plays
 * exactly then. Give it none, and it plays once, when the content first
 * exists. That is why there is no `show` prop and nothing to reset: the
 * absence of state is the point.
 *
 * **A direction is a claim, so only make one where there is a direction to
 * claim.** Walking to the next question of a poll goes one way and coming
 * back goes the other, and the slide is the only thing on screen saying so.
 * Everything else fades and rises a little, which says "this is new" without
 * pretending to say where it came from.
 *
 * A reader who has asked for less motion gets none of this; the rule is in
 * index.css, over the whole app rather than repeated here.
 */
export function Reveal({
  children,
  from = 'below',
}: {
  children: ReactNode
  /** @default 'below' */
  from?: RevealFrom
}) {
  return <div className={`${classes.reveal} ${classes[from]}`}>{children}</div>
}
