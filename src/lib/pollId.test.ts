import { describe, expect, it } from 'vitest'
import { pollIdFromParam, pollPath, shortPollId } from './pollId'

/**
 * The shortened link is the same number in a denser alphabet, and the property
 * that matters is that nothing is lost on the way there and back: a poll's id
 * has to survive being written into a URL and read out of one, or the address
 * leads somewhere else.
 */

/** A uuid-shaped id, from a seeded generator so a failure can be re-run. */
function seededUuid(seed: number): string {
  let state = seed >>> 0
  const hex: string[] = []
  for (let i = 0; i < 32; i += 1) {
    // xorshift32: not random, but spread out and repeatable.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    hex.push((state & 0xf).toString(16))
  }
  const digits = hex.join('')
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    // The version and variant nibbles a v4 uuid fixes.
    '4' + digits.slice(13, 16),
    '8' + digits.slice(17, 20),
    digits.slice(20),
  ].join('-')
}

describe('shortPollId', () => {
  it('is 22 characters where the id is 36', () => {
    const id = seededUuid(1)
    expect(id).toHaveLength(36)
    expect(shortPollId(id)).toHaveLength(22)
  })

  it('spends nothing on characters a URL would have to escape', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      expect(shortPollId(seededUuid(seed))).toMatch(/^[A-Za-z0-9_-]{22}$/)
    }
  })

  it('round-trips every id it is given', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const id = seededUuid(seed)
      expect(pollIdFromParam(shortPollId(id))).toBe(id)
    }
  })

  it('keeps distinct ids distinct', () => {
    const ids = new Set<string>()
    const shorts = new Set<string>()
    for (let seed = 1; seed <= 500; seed += 1) {
      ids.add(seededUuid(seed))
      shorts.add(shortPollId(seededUuid(seed)))
    }
    expect(shorts.size).toBe(ids.size)
  })

  it('matches what Postgres encodes, on a known id', () => {
    // select rtrim(translate(encode(uuid_send(
    //   '3a2697f9-dd9d-4b24-8519-4837d9da6c22'), 'base64'), '+/', '-_'), '=')
    expect(shortPollId('3a2697f9-dd9d-4b24-8519-4837d9da6c22')).toBe('OiaX-d2dSySFGUg32dpsIg')
  })
})

describe('pollIdFromParam', () => {
  it('still reads the long form, which is what keeps old links alive', () => {
    const id = seededUuid(7)
    expect(pollIdFromParam(id)).toBe(id)
  })

  it('reads an uppercased uuid as the id it is', () => {
    const id = seededUuid(9)
    expect(pollIdFromParam(id.toUpperCase())).toBe(id.toUpperCase())
  })

  it('hands back the sample ids untouched, in both directions', () => {
    for (const id of ['sample-dinner', 'sample-result-dinner', 'sample-when']) {
      expect(shortPollId(id)).toBe(id)
      expect(pollIdFromParam(id)).toBe(id)
      expect(pollPath(id)).toBe(`/polls/${id}`)
    }
  })

  it('hands back a mistyped address for the read to fail on', () => {
    for (const junk of ['', 'nope', 'not-a-uuid-at-all', '../etc/passwd']) {
      expect(pollIdFromParam(junk)).toBe(junk)
    }
  })
})

describe('pollPath', () => {
  it('is where the short spelling is written, and the only place', () => {
    const id = seededUuid(11)
    expect(pollPath(id)).toBe(`/polls/${shortPollId(id)}`)
    expect(pollIdFromParam(pollPath(id).replace('/polls/', ''))).toBe(id)
  })
})
