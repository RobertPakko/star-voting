import { describe, expect, it } from 'vitest'
import { percentagesOf } from './shares'

describe('percentagesOf', () => {
  it('adds up to exactly 100', () => {
    expect(percentagesOf({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })).toEqual({ a: 34, b: 33, c: 33 })
  })

  it('hands the spare points to the largest remainders', () => {
    // 42.97, 35.85, 21.19: floors sum to 98, so tacos and sushi round up.
    expect(percentagesOf({ tacos: 0.4297, sushi: 0.3585, pizza: 0.2119 })).toEqual({
      tacos: 43,
      sushi: 36,
      pizza: 21,
    })
  })

  it('keeps a share of nothing at 0', () => {
    expect(percentagesOf({ a: 0.75, b: 0.25, c: 0 })).toEqual({ a: 75, b: 25, c: 0 })
  })

  it('divides nothing when the shares sum to nothing', () => {
    expect(percentagesOf({ a: 0, b: 0 })).toEqual({ a: 0, b: 0 })
  })
})
