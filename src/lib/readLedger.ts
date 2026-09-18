/**
 * What a watching page still owes itself a read for, and what a read it has
 * just made covers.
 *
 * This is the bookkeeping behind `useLiveStream`, kept apart from it because
 * it is the one part that can be wrong quietly. Getting it wrong in one
 * direction costs a wasted round trip; in the other it leaves a page showing
 * votes that have since been overtaken, which is the failure that hook exists
 * to prevent. A closure over four variables inside a two-hundred-line effect
 * is not a thing anything can check, and this is — see readLedger.test.ts.
 *
 * The rule it states is one sentence, and everything here is that sentence:
 *
 * > **A signal received before a read starts is covered by that read.**
 *
 * Which holds because of the order the database does things in. A broadcast is
 * sent when the transaction behind it commits, so it can only reach this
 * browser afterwards — and a read that starts after it arrives therefore reads
 * a database that already holds it. A signal that turns up *during* a read is
 * not covered: its commit may fall after that read's snapshot, and the read
 * would answer without it.
 *
 * That is what lets a page's own read absorb the echo of its own write. It
 * used to be a boolean — *something arrived while I was reading* — which could
 * say that a read was outstanding but never that one had already been
 * accounted for, so every echo cost a second read of the same poll.
 */

/**
 * What a read in flight will have covered when it lands, taken when it is
 * sent. Opaque to the caller: it goes to `starting` and comes back to
 * `settled`, and holding it is what makes two reads in flight impossible to
 * confuse.
 */
export interface ReadMark {
  /** Signals received when this read went out. */
  upTo: number
  /** Whether it was carrying an outright demand; see `insisted`. */
  unconditional: boolean
}

export interface ReadLedger {
  /** A broadcast arrived: the poll moved, and nobody has said how. */
  signalled(): void
  /**
   * A read that no finished read can be said to cover: a subscription
   * arriving, which replays nothing and so has no signal to count, or a page
   * saying it has just written something — because what it wrote may have
   * landed after the snapshot of a read already in the air.
   */
  insisted(): void
  /** Whether anything is outstanding. */
  owing(): boolean
  /** A read is going out. */
  starting(): ReadMark
  /**
   * And it came back. A read that did not work covers nothing and leaves
   * everything outstanding, including whatever arrived while it was in the
   * air.
   */
  settled(mark: ReadMark, ok: boolean): void
}

export function readLedger(): ReadLedger {
  // How many signals have arrived, and how many of them a *finished* read has
  // accounted for.
  let received = 0
  let covered = 0
  // A demand no read in flight can answer; see `insisted`.
  let owed = false

  return {
    signalled() {
      received += 1
    },

    insisted() {
      owed = true
    },

    owing() {
      return owed || received > covered
    },

    starting() {
      // The demand leaves the ledger with the read that is about to answer
      // it, so a second demand arriving while this one is in the air is a
      // second read rather than one this one silently swallows.
      const mark = { upTo: received, unconditional: owed }
      owed = false
      return mark
    },

    settled(mark, ok) {
      if (ok) {
        covered = mark.upTo
        return
      }
      // Put back rather than assigned: a page that asked while this read was
      // in the air is owed one of its own, and must not be forgotten by a
      // read that failed before it was asked.
      owed = owed || mark.unconditional
    },
  }
}
