import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readPollDefaults, savePollDefaults } from './pollDefaults'

/**
 * A stored value is read back field by field, so one this build cannot read
 * costs only that field, and storage that throws costs nothing but the memory.
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

const FALLBACK = {
  mode: 'invite',
  showVoters: false,
  showBallots: false,
  solicitOptions: false,
  multiQuestion: false,
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

describe('poll defaults', () => {
  test('start from the fallback when nothing is saved', () => {
    expect(readPollDefaults()).toEqual(FALLBACK)
  })

  test('come back as they were saved', () => {
    const saved = {
      mode: 'open',
      showVoters: true,
      showBallots: true,
      solicitOptions: false,
      multiQuestion: true,
    } as const
    savePollDefaults(saved)
    expect(readPollDefaults()).toEqual(saved)
  })

  test('drop a damaged field alone', () => {
    localStorage.setItem(
      'star-voting:poll-defaults',
      JSON.stringify({ mode: 'everyone', showBallots: true, showVoters: 'yes' }),
    )
    expect(readPollDefaults()).toEqual({ ...FALLBACK, showBallots: true })
  })

  test('survive a value that is not JSON, and storage that throws', () => {
    localStorage.setItem('star-voting:poll-defaults', '{not json')
    expect(readPollDefaults()).toEqual(FALLBACK)

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => savePollDefaults({ ...FALLBACK, mode: 'open' })).not.toThrow()
    expect(readPollDefaults()).toEqual(FALLBACK)
  })
})
