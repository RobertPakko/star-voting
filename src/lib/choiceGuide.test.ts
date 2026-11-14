import { describe, expect, it } from 'vitest'
import { CHOICE_GUIDE, guidePaths } from './choiceGuide'
import { CHOICE_ORDER, CHOICE_PAGE_ORDER } from './choices'

describe('the choice guide', () => {
  it('reaches every choice exactly once', () => {
    const reached = guidePaths().map((path) => path.choice)
    expect([...reached].sort()).toEqual([...CHOICE_ORDER].sort())
  })

  it('lists each path in the order its answers are given', () => {
    expect(guidePaths(CHOICE_GUIDE)[0]).toEqual({
      answers: ['Pick an option', 'No, we want what’s best for the group as a whole'],
      choice: 'option',
    })
  })

  it('reaches the choices in the order /choices lists them', () => {
    expect(guidePaths().map((path) => path.choice)).toEqual(CHOICE_PAGE_ORDER)
  })
})
