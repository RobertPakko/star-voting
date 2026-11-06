/**
 * The draw behind *Spin the wheel* on a fractional result: one option, chosen
 * with probability equal to its share. Over many decisions the group's
 * choices then come out in the proportions the shares say, one at a time.
 *
 * **The draw is made before the wheel moves.** The spin is an animation to a
 * place already chosen, so the answer cannot depend on frame timing, a slow
 * device or when the reader looks away. `landingFor` decides both the option
 * and where on its slice the pointer comes to rest; the component only
 * animates there.
 *
 * **Unlike the coin, it is a fresh draw every time, per reader.** The coin
 * settles one tie once and so must be the same for everybody (see
 * `coinFlip.ts`); a wheel is for a decision made again and again, so each
 * spin has to be independent of the last. It writes nothing. A group spins
 * one screen together.
 */

export interface Slice {
  id: string
  share: number
}

export interface Landing {
  /** The option drawn. */
  id: string
  /**
   * Where the pointer rests, in degrees clockwise from the top of the wheel,
   * on a wheel whose slices run clockwise from the top in the order given.
   */
  angle: number
}

/**
 * How much of each end of a slice the pointer never rests on, as a fraction
 * of the slice: a pointer stopped on the line between two colours leaves the
 * group arguing over which one it meant. Display only — the option is drawn
 * first, with its full share.
 */
const EDGE = 0.15

/** A uniform number in [0, 1), from the browser's cryptographic source. */
export function uniform(): number {
  const word = new Uint32Array(1)
  crypto.getRandomValues(word)
  return word[0] / 2 ** 32
}

/**
 * Draws one slice, weighted by share, and a resting angle inside it. `random`
 * is called twice: once for the option, once for the angle. Slices with no
 * share can never be drawn. Null when nothing has a share.
 */
export function landingFor(slices: Slice[], random: () => number = uniform): Landing | null {
  const live = slices.filter((s) => s.share > 0)
  const total = live.reduce((sum, s) => sum + s.share, 0)
  if (total <= 0) return null

  const target = random() * total
  let start = 0
  for (const [i, s] of live.entries()) {
    const end = start + s.share
    // The last slice takes whatever floating-point leaves past the end.
    if (target < end || i === live.length - 1) {
      const within = EDGE + (1 - 2 * EDGE) * random()
      return { id: s.id, angle: ((start + s.share * within) / total) * 360 }
    }
    start = end
  }
  return null
}

/**
 * The rotation, in degrees clockwise, that brings `angle` under a pointer at
 * the top, from a wheel already turned by `from`: at least `turns` whole
 * turns further on, so every spin goes the same way and looks like a spin.
 */
export function rotationTo(from: number, angle: number, turns: number): number {
  const rest = (((360 - angle - from) % 360) + 360) % 360
  return from + turns * 360 + rest
}
