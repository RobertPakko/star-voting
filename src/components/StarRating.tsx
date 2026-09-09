import { useRef, useState } from 'react'
import { StarIcon } from '@phosphor-icons/react'
import classes from './StarRating.module.css'

const COUNT = 5

/**
 * The 0–5 star control a voter scores an option with.
 *
 * Deliberately not Mantine's `Rating`, which scored the wrong option on a
 * phone. Two things about it are touch-only — invisible in a desktop browser
 * or its device emulator — and both were live on the ballot at once:
 *
 * - It sets the score from `touchstart`, off the finger's x coordinate against
 *   the row's bounding box, so a finger landing on a star row only to *scroll*
 *   scored that option on the way past. With re-tap-to-clear on top, landing
 *   on the star already picked wiped the score outright.
 * - The tap is then applied again by the click the browser synthesises after
 *   it. Mantine suppresses that with a `preventDefault` in `touchend`, which
 *   browsers honour unevenly; where it does not hold, the second pass runs
 *   into re-tap-to-clear and takes the score back to 0.
 *
 * So: one event path, `click`, which every browser agrees on, and no
 * coordinate arithmetic — a star is a button and says which score it is.
 * Scrolling with a finger on the stars scrolls, and nothing else.
 *
 * 0 is a real score rather than the absence of one, and the only way to reach
 * it is to press the star already picked. The ballot says so above the
 * options.
 *
 * The group is a radio group to a screen reader: one tab stop, arrow keys to
 * move between the scores, Left from one star clearing back to 0.
 *
 * Every change to the score, from a tap or from the keyboard, goes through
 * `apply`, which is also the only thing that knows which way the score just
 * moved and which star was pressed to move it. Both are for the animation and
 * neither leaves this file; see StarRating.module.css for what they draw.
 */
export function StarRating({
  value,
  onChange,
  label,
  onPointerDown,
}: {
  value: number
  onChange: (value: number) => void
  /** Names the group, since the option's name is not inside it. */
  label: string
  /** The open ballot uses this to drop the name field's keyboard. */
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>
}) {
  const stars = useRef<(HTMLButtonElement | null)[]>([])
  // The star that took the press, until its animation is done with it. Which
  // way the score moved is not held anywhere: each star takes its own timing
  // from the state it is arriving at, which is the only version of this that a
  // browser gets right. See StarRating.module.css.
  const [pressed, setPressed] = useState<number | null>(null)

  /**
   * The one way the score changes, whichever control changed it.
   *
   * `pressed` is the star the reader actually acted on rather than the score
   * they landed on, and the two come apart on exactly the press this control
   * is worst at showing: pressing the third star when it is already picked
   * scores 0, and the star to answer for that is the third.
   */
  function apply(next: number, star: number) {
    setPressed(star)
    onChange(next)
  }

  function move(to: number) {
    // The star that keeps the focus is the one that took the press; 0 has no
    // star of its own and the first one stands in, exactly as below.
    apply(to, Math.max(to, 1))
    // Focus follows the score, so the next arrow press continues from it
    // rather than from where the finger or the tab stop left off. 0 has no
    // star of its own; the first one keeps the focus.
    stars.current[Math.max(to, 1) - 1]?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent, star: number) {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    if (step !== undefined) {
      event.preventDefault()
      move(Math.min(Math.max(star + step, 0), COUNT))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      move(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      move(COUNT)
    }
  }

  return (
    <div
      className={classes.group}
      role="radiogroup"
      aria-label={label}
      onPointerDown={onPointerDown}
    >
      {Array.from({ length: COUNT }, (_, index) => {
        const star = index + 1
        return (
          <button
            key={star}
            ref={(node) => {
              stars.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
            // One tab stop for the group, on the score it is showing, so a
            // keyboard reaches the next option rather than the next star.
            tabIndex={star === Math.max(value, 1) ? 0 : -1}
            className={classes.star}
            data-filled={star <= value || undefined}
            data-pressed={pressed === star || undefined}
            style={{ '--star': index } as React.CSSProperties}
            onClick={() => apply(star === value ? 0 : star, star)}
            onKeyDown={(event) => handleKeyDown(event, star)}
            // Handing the star back once it has finished is what lets the
            // next press on the same star play at all: the attribute has to
            // leave before it can arrive again.
            onAnimationEnd={() => setPressed(null)}
          >
            <StarIcon size={20} weight="fill" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
