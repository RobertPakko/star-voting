import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Stack, type MantineSpacing } from '@mantine/core'
import { motionEase, motionMs, prefersReducedMotion } from '../lib/motion'

/**
 * Below this, a change of height is left to happen at once: a line of text
 * wrapping, a badge growing a digit. Animating those reads as the page being
 * slow rather than as something arriving.
 */
const NOTICEABLE_PX = 12

/** What draws a card's frame: its border and background. */
const CARD = '.mantine-Card-root'

/**
 * The card a swap put in, when there is one to move: the element that arrived,
 * or the first thing inside it — *your vote is in* is a stack holding its card
 * and the banners under it.
 */
function frameOf(added: Element | undefined): HTMLElement | null {
  if (!(added instanceof HTMLElement)) return null
  if (added.matches(CARD)) return added
  const first = added.firstElementChild
  return first instanceof HTMLElement && first.matches(CARD) ? first : null
}

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
 * seen and then taken back. The height it moves *from* is the block's last
 * measured size, which a `ResizeObserver` keeps current.
 *
 * **The content changes at once, and the card's frame moves.** What animates
 * is the height of the card that arrived, with what is inside it clipped to
 * it: growing, its border moves down over content that is already there;
 * shrinking, it closes up the empty card under content that is already there.
 * Either way the reader sees the new card from the first frame, and what is
 * under it is pushed rather than covered. A clip around the whole block was
 * tried first and can only fake the grow: a shrink has nothing taller left to
 * clip, so the new card's edge snapped up and only a gap closed under it.
 *
 * Where what arrived is not a card, the block's own height moves instead,
 * clipped (`overflow: clip`, which unlike `hidden` makes no scroll container,
 * so nothing sticky inside comes unstuck). That only reads well growing, and
 * only for what is in the block, which is why it is the fallback: **wrap the
 * card that swaps, not the list it is in**.
 *
 * Something that manages its own height across a swap can opt out by
 * standing inside `[data-own-height]`; the calendar does, since it already
 * holds the page still across a change of view and two corrections at once
 * would fight. **Anything that grows or shrinks its own height gradually
 * must opt out too** (a row joining a list, `listRow.module.css`): when it
 * moves in the same commit as a swap elsewhere in the block, the height is
 * measured with it still at its start, and the clip hides whatever is under
 * it until the animation ends. The option list and `NameRoster` opt out for
 * that reason. A SmoothHeight is marked the same way, so one can stand
 * inside another: the inner one moves for its own swaps and the outer one
 * for the rest.
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
    // What is being moved and clipped: the arriving card, or this block.
    let moving: HTMLElement | null = null

    const settle = () => {
      if (moving) moving.style.overflow = ''
      moving = null
    }

    const sizes = new ResizeObserver(() => {
      // While this block is the thing moving, what it holds is already at its
      // new size, and the animation is the record. A moving card is inside
      // it, so its size is the size on screen.
      if (moving !== box) last = content.getBoundingClientRect().height
    })
    sizes.observe(content)

    const swaps = new MutationObserver((records) => {
      // `closest` would also find this block's own mark, which is outside it.
      const ownsHeight = (target: Node) => {
        const owner = target instanceof Element ? target.closest('[data-own-height]') : null
        return !!owner && content.contains(owner)
      }
      const mine = records.filter((record) => !ownsHeight(record.target))
      const arrived = mine.flatMap((r) => [...r.addedNodes]).find((n) => n instanceof Element)
      const swapped = mine.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element),
      )
      // From wherever it has got to, if it is already on its way somewhere.
      const from = running && moving === box ? box.getBoundingClientRect().height : last
      if (swapped) {
        running?.cancel()
        running = null
        settle()
      }
      const next = content.getBoundingClientRect().height
      last = next
      if (!swapped || prefersReducedMotion() || Math.abs(next - from) < NOTICEABLE_PX) return

      const frame = frameOf(arrived)
      const target = frame && content.contains(frame) ? frame : box
      // The card ends at its own height and starts short or tall by however
      // far the whole block moved; the block, at the two heights themselves.
      const end = target === box ? next : target.getBoundingClientRect().height
      const start = Math.max(0, end + from - next)
      moving = target
      target.style.overflow = 'clip'
      const move = target.animate([{ height: `${start}px` }, { height: `${end}px` }], {
        duration: motionMs('resize'),
        easing: motionEase(),
      })
      running = move
      void move.finished
        .then(() => {
          if (running !== move) return
          running = null
          settle()
          last = content.getBoundingClientRect().height
        })
        .catch(() => undefined)
    })
    swaps.observe(content, { childList: true, subtree: true })

    return () => {
      sizes.disconnect()
      swaps.disconnect()
      running?.cancel()
      settle()
    }
  }, [])

  return (
    // Marked as managing its own height, so a SmoothHeight around this one
    // leaves the swaps inside it to this one.
    <div ref={outer} data-own-height>
      <Stack ref={inner} gap={gap}>
        {children}
      </Stack>
    </div>
  )
}
