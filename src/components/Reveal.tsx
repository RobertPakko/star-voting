import type { ReactNode } from 'react'
import classes from './Reveal.module.css'

/**
 * Content arriving, wherever content arrives.
 *
 * Three things in the app appear in place of something else — a skeleton
 * filling in, a page replacing the page before it, and the winner card once
 * there is a winner — and all three were an instant swap. A swap is the one
 * thing a reader cannot follow: something is in a place, and then something
 * else is, and nothing on screen said which of the two just happened.
 *
 * So they share an entrance, for the reason `BallotCard` and `PollHeading`
 * are each one component: three copies of a fade are three things to keep in
 * step, and motion drifts even faster than wording because nobody can diff
 * it.
 *
 * **It runs on mount, which makes the `key` the whole of the mechanism.** An
 * entrance is not a thing to trigger; it is what happens when an element is
 * new. Give it a key that changes when the content is genuinely a different
 * thing — the page being opened — and it plays exactly then. Give it none, and
 * it plays once, when the content first exists. That is why there is no `show`
 * prop and nothing to reset: the absence of state is the point.
 *
 * **Mounting again is not the same as being different, and only the second one
 * earns an entrance.** Walking between the questions of a poll re-mounts the
 * card under the question strip, and the strip is inside that card — so
 * wrapping the card played a full entrance on a strip that had not changed a
 * pixel, which reads as the navigation reloading itself every time it is used.
 * The strip belongs to the poll rather than to the question, like the heading
 * above it, and the page goes to real trouble to keep both still across a
 * crossing; an animation is not exempt from that just because React happened
 * to rebuild the DOM. What genuinely changes on a crossing is the tally or the
 * ballot, and `Results` and `Ballots` announce themselves.
 *
 * **Wrap one element, not several.** This puts a box around what it wraps, and
 * where that is several elements a fragment was flattening into a `Stack`, the
 * box takes them out of it: they were being spaced by the stack and now they
 * are being spaced by nothing. It cost the rule under the question strip once
 * already. One element is always safe — the box stands where the element
 * stood, and is spaced exactly as it was.
 *
 * A reader who has asked for less motion gets none of this; the rule is in
 * index.css, over the whole app rather than repeated here.
 */
export function Reveal({ children }: { children: ReactNode }) {
  return <div className={classes.reveal}>{children}</div>
}
