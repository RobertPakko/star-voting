import { describe, expect, test } from 'vitest'
import { readLedger } from './readLedger'

/**
 * The one rule, from both sides: a signal received before a read starts is
 * covered by that read, and one that arrives during it is not.
 *
 * Every case here is a thing that can only be wrong quietly. A ledger that
 * over-covers leaves a page showing a poll that has moved; one that
 * under-covers costs a round trip per press and looks like nothing at all.
 */
describe('what a read covers', () => {
  test('a page that has been told nothing is owed nothing', () => {
    expect(readLedger().owing()).toBe(false)
  })

  test('a signal is outstanding until a read answers it', () => {
    const ledger = readLedger()
    ledger.signalled()
    expect(ledger.owing()).toBe(true)

    const mark = ledger.starting()
    ledger.settled(mark, true)
    expect(ledger.owing()).toBe(false)
  })

  test('a signal received before the read starts is covered by it', () => {
    const ledger = readLedger()
    // The echo of this page's own write, arriving before the request that
    // made it had even come back.
    ledger.signalled()
    const mark = ledger.starting()
    ledger.settled(mark, true)

    expect(ledger.owing()).toBe(false)
  })

  test('a signal received while the read is in the air is not', () => {
    const ledger = readLedger()
    const mark = ledger.starting()
    // Somebody else's vote, committed after this read's snapshot for all
    // anyone here knows.
    ledger.signalled()
    ledger.settled(mark, true)

    expect(ledger.owing()).toBe(true)
  })

  test('several signals during one read collapse into one that is owed', () => {
    const ledger = readLedger()
    const mark = ledger.starting()
    ledger.signalled()
    ledger.signalled()
    ledger.signalled()
    ledger.settled(mark, true)

    expect(ledger.owing()).toBe(true)
    const next = ledger.starting()
    ledger.settled(next, true)
    expect(ledger.owing()).toBe(false)
  })

  test('a read that did not work covers nothing', () => {
    const ledger = readLedger()
    ledger.signalled()
    const mark = ledger.starting()
    ledger.settled(mark, false)

    expect(ledger.owing()).toBe(true)
  })
})

describe('a read asked for outright', () => {
  test('is owed until a read that works answers it', () => {
    const ledger = readLedger()
    ledger.insisted()
    expect(ledger.owing()).toBe(true)

    const mark = ledger.starting()
    ledger.settled(mark, true)
    expect(ledger.owing()).toBe(false)
  })

  test('is never answered by a read that was already in the air', () => {
    const ledger = readLedger()
    // A read going out for somebody else's vote...
    const mark = ledger.starting()
    // ...and then this page writes something and asks. What it wrote may
    // have landed after that read's snapshot, so the read cannot speak for
    // it however late it lands.
    ledger.insisted()
    ledger.settled(mark, true)

    expect(ledger.owing()).toBe(true)
  })

  test('survives a read that failed before it was asked', () => {
    const ledger = readLedger()
    const mark = ledger.starting()
    ledger.insisted()
    ledger.settled(mark, false)

    expect(ledger.owing()).toBe(true)
  })

  test('is not left outstanding for ever by a read that failed carrying it', () => {
    const ledger = readLedger()
    ledger.insisted()
    const failed = ledger.starting()
    ledger.settled(failed, false)
    expect(ledger.owing()).toBe(true)

    // The retry behind it is the read that owes it, and clears it.
    const retry = ledger.starting()
    ledger.settled(retry, true)
    expect(ledger.owing()).toBe(false)
  })
})

/**
 * The press this whole thing is about: a confirmation or a vote, which writes,
 * broadcasts, and comes back to the page that made it.
 */
describe('one press', () => {
  test('costs one read when the echo beats the write coming back', () => {
    const ledger = readLedger()
    let reads = 0
    const run = (ok = true) => {
      reads += 1
      ledger.settled(ledger.starting(), ok)
    }

    // The broadcast lands first, and the page reads for it.
    ledger.signalled()
    expect(ledger.owing()).toBe(true)
    run()

    // Then the write comes back and the card asks. The read above started
    // after the echo arrived, so it already holds the confirmation — but the
    // page cannot know that, and asks anyway.
    ledger.insisted()
    expect(ledger.owing()).toBe(true)
    run()

    expect(reads).toBe(2)
  })

  test('costs one read when the echo lands inside the read the page asked for', () => {
    const ledger = readLedger()
    let reads = 0

    // The card asks first, and the read goes out.
    ledger.insisted()
    reads += 1
    const mark = ledger.starting()
    // The echo arrives while it is in the air.
    ledger.signalled()
    ledger.settled(mark, true)

    // Which is not covered, so one trailing read follows -- and just one,
    // however many signals arrived.
    expect(ledger.owing()).toBe(true)
    reads += 1
    ledger.settled(ledger.starting(), true)

    expect(ledger.owing()).toBe(false)
    expect(reads).toBe(2)
  })
})
