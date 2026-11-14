import { describe, expect, it } from 'vitest'
import { CHOICE_GUIDE, guidePaths } from './choiceGuide'
import { CHOICE_ORDER } from './choices'

describe('the choice guide', () => {
  it('reaches every choice exactly once', () => {
    const reached = guidePaths().map((path) => path.choice)
    expect([...reached].sort()).toEqual([...CHOICE_ORDER].sort())
  })

  it('lists each path in the order its answers are given', () => {
    expect(guidePaths(CHOICE_GUIDE)[0]).toEqual({
      answers: ['Pick an option', 'Yes, we want everyone to be at least a little satisfied'],
      choice: 'consensus',
    })
  })
})
