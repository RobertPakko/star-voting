import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Stack, type MantineSpacing } from '@mantine/core'
import { motionEase, motionMs, prefersReducedMotion } from '../lib/motion'

/**
 * Below this, a change of height is left to happen at once: a line of text
 * wrapping, a badge growing a digit. Animating those reads as the page being
 * slow rather than as something arriving.
 */
const NOTICEABLE_PX = 12

/**
 * A block whose height moves to its new size rather than jumping to it, when
 * what is inside it is replaced.
 *
 * The question's half of a poll page swaps one card for another all the time
 * — a ballot for *your vote is in*, *your vote is in* for the ballot again
 * behind Edit vote, an option list for the confirmation after it, a skeleton
 * for the thing it stood in for — and each card is a different height, so the
 * page under it used to jump by the difference between two frames. The
 * question slide answers the same complaint for a crossing; this is it for
 * everything that happens on one question.
 *
 * **It watches the elements, not the page's state.** Most of those swaps are
 * decided inside a card — Edit vote, Confirm options, the editor — where no
 * prop on this wrapper could see them, and threading a "stage" up from each
 * would be a stage per card for ever. So a `MutationObserver` on what it holds
 * notices any element going in or out, and that is the signal. Text changing
 * is not: a field growing as somebody types should keep up with their typing.
 *
 * **It is moved before the browser paints.** A mutation is delivered at the
 * end of the task React committed in, ahead of rendering, so the animation is
 * in place for the very first frame of the new card — the new height is never
 * seen and then taken back. The height it moves *from* is the inner block's
 * last measured size, which a `ResizeObserver` keeps current through the
 * changes that are not swaps; it watches the inner block, whose height is its
 * content's, rather than this one, whose height is being animated.
 *
 * **What is outside it is clipped while it moves**, and only then:
 * `overflow: clip` for the length of the animation, which unlike `hidden`
 * makes no scroll container, so nothing sticky inside it comes unstuck.
 *
 * Something that manages its own height across a swap can opt out by
 * standing inside `[data-own-height]`; the calendar does, since it already
 * holds the page still across a change of view and two corrections at once
 * would fight.
 */
export function SmoothHeight({
  children,
  gap = 'md',
}: {
  children: ReactNode
  /**
   * The spacing between what it holds. It stands in a stack in place of
   * several things that stack was spacing, so it spaces them the same way
   * itself; see Reveal for what it cost to forget that once.
   */
  gap?: MantineSpacing
}) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const box = outer.current
    const content = inner.current
    if (!box || !content) return
    let last = content.getBoundingClientRect().height
    let running: Animation | null = null

    const sizes = new ResizeObserver(() => {
      // Only while nothing is moving: the animation is the record then, and
      // the mutation that started it has already written the size it is
      // heading for.
      if (!running) last = content.getBoundingClientRect().height
    })
    sizes.observe(content)

    const swaps = new MutationObserver((records) => {
      const swapped = records.some(
        (record) =>
          !(record.target instanceof Element && record.target.closest('[data-own-height]')) &&
          [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element),
      )
      const next = content.getBoundingClientRect().height
      // From wherever it has got to, if it is already on its way somewhere.
      const from = running ? box.getBoundingClientRect().height : last
      last = next
      if (!swapped || prefersReducedMotion() || Math.abs(next - from) < NOTICEABLE_PX) return
      running?.cancel()
      box.style.overflow = 'clip'
      const move = box.animate([{ height: `${from}px` }, { height: `${next}px` }], {
        duration: motionMs('base'),
        easing: motionEase(),
      })
      running = move
      void move.finished
        .then(() => {
          if (running !== move) return
          running = null
          box.style.overflow = ''
          last = content.getBoundingClientRect().height
        })
        .catch(() => undefined)
    })
    swaps.observe(content, { childList: true, subtree: true })

    return () => {
      sizes.disconnect()
      swaps.disconnect()
      running?.cancel()
      box.style.overflow = ''
    }
  }, [])

  return (
    <div ref={outer}>
      <Stack ref={inner} gap={gap}>
        {children}
      </Stack>
    </div>
  )
}
