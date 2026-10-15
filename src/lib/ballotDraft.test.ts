import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DRAFT_POLLS_MAX,
  clearBallotDraft,
  forgetSampleDrafts,
  readBallotDraft,
  saveBallotDraft,
  type DraftScope,
} from './ballotDraft'

/**
 * The rules a draft is kept by, each of them one a voter would only notice by
 * losing something: that ten polls are kept and the oldest goes, that a poll of
 * several questions counts once, and that one reader's draft is not another's.
 */

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

const scope = (pollId: string, extra: Partial<DraftScope> = {}): DraftScope => ({
  pollId,
  owner: null,
  ...extra,
})

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  forgetSampleDrafts()
})

describe('a ballot draft', () => {
  test('comes back as it was saved, without its zeros', () => {
    saveBallotDraft(scope('q1'), { a: 4, b: 0, c: 2 })
    expect(readBallotDraft(scope('q1'))).toEqual({ a: 4, c: 2 })
  })

  test('is gone once the ballot goes in, and when nothing is left of it', () => {
    saveBallotDraft(scope('q1'), { a: 4 })
    clearBallotDraft(scope('q1'))
    expect(readBallotDraft(scope('q1'))).toBeNull()

    saveBallotDraft(scope('q2'), { a: 4 })
    saveBallotDraft(scope('q2'), { a: 0 })
    expect(readBallotDraft(scope('q2'))).toBeNull()
    expect(localStorage.getItem('star-voting:ballot-drafts')).toBeNull()
  })

  test('is kept for the ten polls touched last, and the oldest goes first', () => {
    for (let i = 0; i <= DRAFT_POLLS_MAX; i++) saveBallotDraft(scope(`q${i}`), { a: 3 })
    expect(readBallotDraft(scope('q0'))).toBeNull()
    expect(readBallotDraft(scope('q1'))).toEqual({ a: 3 })
    expect(readBallotDraft(scope(`q${DRAFT_POLLS_MAX}`))).toEqual({ a: 3 })

    // Touching a poll again makes it the newest, so it outlives the rest.
    saveBallotDraft(scope('q1'), { a: 5 })
    saveBallotDraft(scope('another'), { a: 3 })
    expect(readBallotDraft(scope('q1'))).toEqual({ a: 5 })
    expect(readBallotDraft(scope('q2'))).toBeNull()
  })

  test('counts a poll of several questions once', () => {
    for (let i = 0; i < 5; i++) saveBallotDraft(scope(`g-q${i}`, { groupId: 'g' }), { a: i + 1 })
    for (let i = 0; i < DRAFT_POLLS_MAX - 1; i++) saveBallotDraft(scope(`other${i}`), { a: 1 })
    for (let i = 0; i < 5; i++) {
      expect(readBallotDraft(scope(`g-q${i}`, { groupId: 'g' }))).toEqual({ a: i + 1 })
    }
    // Clearing one question leaves its siblings alone.
    clearBallotDraft(scope('g-q0', { groupId: 'g' }))
    expect(readBallotDraft(scope('g-q0', { groupId: 'g' }))).toBeNull()
    expect(readBallotDraft(scope('g-q1', { groupId: 'g' }))).toEqual({ a: 2 })
  })

  test('belongs to whoever wrote it', () => {
    saveBallotDraft(scope('q1', { owner: 'alice' }), { a: 4 })
    expect(readBallotDraft(scope('q1', { owner: 'bob' }))).toBeNull()
    expect(readBallotDraft(scope('q1'))).toBeNull()
    expect(readBallotDraft(scope('q1', { owner: 'alice' }))).toEqual({ a: 4 })

    // Somebody else writing to the same poll replaces it rather than merging.
    saveBallotDraft(scope('q2', { owner: 'bob', groupId: 'g' }), { a: 1 })
    saveBallotDraft(scope('q3', { owner: 'carol', groupId: 'g' }), { a: 2 })
    expect(readBallotDraft(scope('q2', { owner: 'bob', groupId: 'g' }))).toBeNull()
  })

  test('drops anything in storage that is not a score', () => {
    localStorage.setItem(
      'star-voting:ballot-drafts',
      JSON.stringify([
        { poll: 'q1', owner: null, questions: { q1: { a: 4, b: 9, c: 'x', d: 2.5 } } },
        'junk',
      ]),
    )
    expect(readBallotDraft(scope('q1'))).toEqual({ a: 4 })
    localStorage.setItem('star-voting:ballot-drafts', '{not json')
    expect(readBallotDraft(scope('q1'))).toBeNull()
  })

  test('is kept in memory, not storage, for the sample, and forgotten with it', () => {
    saveBallotDraft(scope('sample-dinner'), { a: 4 })
    expect(localStorage.getItem('star-voting:ballot-drafts')).toBeNull()
    expect(readBallotDraft(scope('sample-dinner'))).toEqual({ a: 4 })
    forgetSampleDrafts()
    expect(readBallotDraft(scope('sample-dinner'))).toBeNull()
  })

  test('survives storage that refuses, for as long as the tab is open', () => {
    const refusing = memoryStorage()
    refusing.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    refusing.getItem = () => {
      throw new Error('SecurityError')
    }
    vi.stubGlobal('localStorage', refusing)
    saveBallotDraft(scope('q1'), { a: 4 })
    expect(readBallotDraft(scope('q1'))).toEqual({ a: 4 })
  })
})
