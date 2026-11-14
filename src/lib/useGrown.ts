import { useEffect, useState } from 'react'

/**
 * Whether a set of bars may be drawn at their lengths yet: false on the first
 * paint, so they render at zero and grow (`Results.module.css`). Stays true,
 * so a recount moves bars from where they were instead of replaying it.
 */
export function useGrown(): boolean {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    // Two frames: the zero width must actually be painted before the
    // transition, and one rAF after an effect doesn't guarantee that.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGrown(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [])
  return grown
}
