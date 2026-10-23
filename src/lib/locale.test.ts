import { describe, expect, test } from 'vitest'
import { forLanguage } from './locale'

describe('what a language says about dates and times', () => {
  test('American English: Sunday, month first, the 12-hour clock', () => {
    expect(forLanguage('en-US')).toEqual({
      weekStartsOn: 0,
      dayBeforeMonth: false,
      prefers24Hour: false,
    })
  })

  test('British English: Monday, day first, the 24-hour clock', () => {
    // Same language, different region: the region is what decides all three.
    expect(forLanguage('en-GB')).toEqual({
      weekStartsOn: 1,
      dayBeforeMonth: true,
      prefers24Hour: true,
    })
  })

  test('German: Monday, day first, the 24-hour clock', () => {
    expect(forLanguage('de-DE')).toEqual({
      weekStartsOn: 1,
      dayBeforeMonth: true,
      prefers24Hour: true,
    })
  })

  test('Japanese: Sunday, month first', () => {
    // 9月18日 -- month before day, which a check for "day first" must not
    // mistake for the other order just because the language is not English.
    const japanese = forLanguage('ja-JP')
    expect(japanese.weekStartsOn).toBe(0)
    expect(japanese.dayBeforeMonth).toBe(false)
  })

  test('a bare language takes its likeliest region', () => {
    expect(forLanguage('en').weekStartsOn).toBe(0)
  })

  test('nonsense falls back rather than throwing', () => {
    expect(forLanguage('not a language tag')).toEqual({
      weekStartsOn: 1,
      dayBeforeMonth: false,
      prefers24Hour: false,
    })
  })
})
