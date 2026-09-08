import { useRef } from 'react'
import type { RevealFrom } from '../components/Reveal'

/**
 * Which way a reader just moved through a poll's questions.
 *
 * A poll that asks several questions is walked through with *Previous* and
 * *Next*, and the two are the same event on screen: the card under the strip
 * is replaced. Which direction that was is a fact the reader supplied and the
 * page then threw away — so the strip could say *Question 3 of 5* while the
 * page gave no sign whether 3 had been arrived at from 2 or from 4.
 *
 * The answer is worth about fourteen pixels of slide, which is all this is
 * for. Both poll pages ask it, and they ask it of the same list in the same
 * order, so it is one function rather than the same eight lines twice.
 *
 * **Answered during the render that opens the question, not after it.** The
 * card is drawn once, on the render where the address changes, and its
 * entrance begins the moment it exists — so an answer settled in an effect
 * would arrive a frame after the animation it was meant to describe, and
 * every crossing would slide the way the *last* one went. That is why the
 * previous question is kept in a ref and compared here rather than watched:
 * there is no state to set, because there is nothing to re-render.
 *
 * Re-running it on the same question changes nothing, which is what makes it
 * safe to call twice for one render.
 *
 * @param current The question being opened.
 * @param order Every question of the poll, in the order the strip lists them.
 */
export function useCrossingDirection(current: string, order: string[]): RevealFrom {
  const previous = useRef(current)
  // Plain until there is a crossing to describe: arriving at a poll from
  // anywhere else came from no question at all, and a slide would be claiming
  // a direction the reader did not travel in.
  const from = useRef<RevealFrom>('below')

  if (previous.current !== current) {
    const was = order.indexOf(previous.current)
    const now = order.indexOf(current)
    previous.current = current
    // Forward comes in from the right and back from the left, which is the way
    // every stack of pages on a phone moves: the poll runs left to right like
    // the strip drawing it, so *Next* brings the new question in from the edge
    // it was sitting past.
    //
    // Unless one of the two is not in the strip, which is an arrival wearing a
    // crossing's clothes: a poll opened at one question and re-read at another
    // it has never held a list for. That came from nowhere in particular.
    if (was !== -1 && now !== -1) from.current = now < was ? 'left' : 'right'
    else from.current = 'below'
  }

  return from.current
}
