import { describe, expect, it } from 'vitest'
import { landingFor, rotationTo, uniform } from './wheel'

/** A `random` that answers the given numbers in turn. */
const answers = (...values: number[]) => {
  let i = 0
  return () => values[i++]
}

const slices = [
  { id: 'tacos', share: 0.5 },
  { id: 'sushi', share: 0.3 },
  { id: 'none', share: 0 },
  { id: 'pizza', share: 0.2 },
]

describe('landingFor', () => {
  it('draws each option over its share of the line', () => {
    expect(landingFor(slices, answers(0, 0.5))?.id).toBe('tacos')
    expect(landingFor(slices, answers(0.49, 0.5))?.id).toBe('tacos')
    expect(landingFor(slices, answers(0.5, 0.5))?.id).toBe('sushi')
    expect(landingFor(slices, answers(0.79, 0.5))?.id).toBe('sushi')
    expect(landingFor(slices, answers(0.8, 0.5))?.id).toBe('pizza')
    expect(landingFor(slices, answers(0.999999, 0.5))?.id).toBe('pizza')
  })

  it('rests inside the drawn slice, clear of its edges', () => {
    // Sushi runs from 180° to 288°; the outer 15% at each end is never used.
    expect(landingFor(slices, answers(0.6, 0))?.angle).toBeCloseTo(180 + 108 * 0.15)
    expect(landingFor(slices, answers(0.6, 0.5))?.angle).toBeCloseTo(234)
    expect(landingFor(slices, answers(0.6, 0.999999))?.angle).toBeCloseTo(180 + 108 * 0.85, 3)
  })

  it('never draws an option with no share', () => {
    for (let i = 0; i < 2000; i++) expect(landingFor(slices)?.id).not.toBe('none')
  })

  it('draws nothing when nothing has a share', () => {
    expect(landingFor([{ id: 'a', share: 0 }])).toBeNull()
  })

  it('comes out in proportion to the shares', () => {
    const tally: Record<string, number> = { tacos: 0, sushi: 0, pizza: 0 }
    const n = 50_000
    for (let i = 0; i < n; i++) tally[landingFor(slices)!.id]++
    expect(tally.tacos / n).toBeCloseTo(0.5, 1)
    expect(tally.sushi / n).toBeCloseTo(0.3, 1)
    expect(tally.pizza / n).toBeCloseTo(0.2, 1)
  })
})

describe('uniform', () => {
  it('stays in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const u = uniform()
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })
})

describe('rotationTo', () => {
  it('brings the angle under the pointer at the top', () => {
    for (const from of [0, 90, 1234.5]) {
      for (const angle of [0, 45, 200, 359]) {
        const to = rotationTo(from, angle, 5)
        // A point at `angle` clockwise from the top, turned by `to`, sits at the top.
        expect((((angle + to) % 360) + 360) % 360).toBeCloseTo(0)
      }
    }
  })

  it('always turns forward, by at least the turns asked for', () => {
    const to = rotationTo(100, 10, 5)
    expect(to - 100).toBeGreaterThanOrEqual(5 * 360)
    expect(to - 100).toBeLessThan(6 * 360)
  })
})
