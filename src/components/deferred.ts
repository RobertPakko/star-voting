import { createElement, use, type ComponentType } from 'react'
import type { PollRead } from '../lib/types'

/**
 * What `lazy()` does, with one thing it cannot: a chunk fetched ahead of time
 * is drawn on the first render that asks for it.
 *
 * `lazy()` reads its module through a promise it makes itself the first time
 * the component renders, and a promise is never settled when it is made — so
 * even a chunk already in the browser suspends once and puts its fallback up,
 * for at least a frame and in practice longer, since React holds a boundary's
 * content back for up to 300ms after its fallback has gone up. A poll opened
 * at its link therefore went skeleton, a second skeleton, the poll: the page
 * arrived, and the tally under it was still a placeholder.
 *
 * Here the promise is made once, by whoever asks first — `preload`, or the
 * first render — and marks itself settled the way React's `use` reads a
 * promise: `status` and `value`. So once the chunk is in, `use` hands the
 * component back without suspending, and `preloadCards` below is what lets
 * the route fetch it while it is still waiting on the read anyway.
 *
 * One component per chunk for the life of the page, as `lazy()` was, so a
 * card never remounts because a different page started drawing it.
 */
type Settling<T> = Promise<T> & {
  status?: 'pending' | 'fulfilled' | 'rejected'
  value?: T
  reason?: unknown
}

function deferred<P extends object>(name: string, load: () => Promise<ComponentType<P>>) {
  let loading: Promise<ComponentType<P>> | null = null
  const preload = () => {
    if (!loading) {
      const promise = load()
      const settling = promise as Settling<ComponentType<P>>
      promise.then(
        (value) => {
          settling.status = 'fulfilled'
          settling.value = value
        },
        (reason: unknown) => {
          settling.status = 'rejected'
          settling.reason = reason
        },
      )
      loading = promise
    }
    return loading
  }
  function Deferred(props: P) {
    return createElement(use(preload()), props)
  }
  Deferred.displayName = name
  return Object.assign(Deferred, { preload })
}

/**
 * The cards a finished poll draws, fetched when a poll finishes rather than
 * bundled with the ballot.
 *
 * Both are already rendered behind a condition — `results_available`, and
 * `show_ballots` on top of it for the sheet — so the reader who pays for them
 * is the one looking at a tally, and the reader who does not is the one
 * filling in a ballot. Between them they carry the tie-break prose, the full
 * ranking behind its modal and the published sheet's table, none of which a
 * voter needs to score five options.
 *
 * They wait behind `ResultsSkeleton` and `BallotsSkeleton`, which is what
 * they already waited behind: both cards fetch their own tally when the read
 * that opened the page did not bring one, and that wait has looked like this
 * all along. The fetch and the fetch of the code for it now share one shape.
 *
 * Declared here rather than at each call site because two pages draw them —
 * `PollDetail` and `OpenPollPanel` — and two `deferred()` calls over one module
 * would be two component identities for one component, remounting the card
 * on any render that swapped which page held it.
 *
 * The types stay where their components are: `import type` is erased, so a
 * caller naming `ResultsSource` does not pull the chunk in with it.
 */

export const Results = deferred('Results', () => import('./Results').then((m) => m.Results))

export const Ballots = deferred('Ballots', () => import('./Ballots').then((m) => m.Ballots))

/**
 * And the reader's own ballot, which is the other half of the same branch: a
 * poll's results draw the published grid or this, never both, so exactly one
 * of the two chunks is ever fetched. See `YourBallot`, and `PollDetail`, which
 * picks between them.
 */
export const YourBallot = deferred('YourBallot', () =>
  import('./YourBallot').then((m) => m.YourBallot),
)

/**
 * And the calendar a time poll is voted on, for the same reason and a
 * sharper one: it is the only part of this app with a real dependency behind
 * it. `@mantine/schedule` and the `rrule` it carries are around 250 kB
 * unminified, which is more than everything else on the ballot put together,
 * and every poll that chooses an option would have paid for it on first paint
 * to draw a list of stars.
 *
 * Declared here rather than at its two call sites for the reason above:
 * `VoteForm` on the invite page and `OpenBallot` behind a share link both
 * draw it, and two `deferred()` calls over one module would remount the ballot --
 * with whatever was painted on it -- on any render that swapped which of them
 * held it.
 */
export const TimeBallotCard = deferred('TimeBallotCard', () =>
  import('./TimeBallotCard').then((m) => m.TimeBallotCard),
)

/**
 * And the results' calendars, which stand in for the two cards above on a
 * time poll: the reader's own ballot and the published sheet, read back onto
 * the calendar they were painted on. Behind a `deferred()` of their own rather
 * than imported by `Ballots` and `YourBallot`, because they carry
 * `PaintCalendar` and the library under it -- and a poll that chooses an
 * option, which is most of them, should fetch the sheet's table and nothing
 * of the calendar. See ScheduleBallots.
 */
export const ScheduleBallot = deferred('ScheduleBallot', () =>
  import('./ScheduleBallots').then((m) => m.ScheduleBallot),
)

export const ScheduleBallots = deferred('ScheduleBallots', () =>
  import('./ScheduleBallots').then((m) => m.ScheduleBallots),
)

/**
 * Fetches the code for the cards a poll's read is about to draw, and settles
 * when it is in — never rejecting, since a chunk that will not load is
 * `staleBuild`'s to answer and the card's own render will say so.
 *
 * Asked by whatever is holding a read it has not drawn yet: `PollPage` while
 * its skeleton is up, and the pages' own reads on a crossing. Waiting on it
 * there is what makes the page arrive whole, rather than arriving and then
 * filling in its tally behind a second skeleton.
 *
 * Generous rather than exact. Which of these a page draws turns on several
 * conditions — whether this reader voted, whether a ballot is being changed —
 * and restating them here would be a second copy of each to drift; a chunk
 * fetched that the page then does not draw costs a few kilobytes, once.
 */
export function preloadCards(page: PollRead): Promise<void> {
  const facts =
    page.kind === 'account'
      ? {
          finished: page.status.results_available,
          published: page.poll.show_ballots,
          time: page.poll.kind === 'time',
        }
      : page.kind === 'open'
        ? {
            finished: page.view.results_available,
            published: page.view.poll.show_ballots,
            time: page.view.poll.kind === 'time',
          }
        : null
  if (!facts) return Promise.resolve()
  const { finished, published, time } = facts
  const wanted: Promise<unknown>[] = []
  if (finished) {
    wanted.push(Results.preload(), (published ? Ballots : YourBallot).preload())
    if (time) wanted.push((published ? ScheduleBallots : ScheduleBallot).preload())
  } else if (time) {
    wanted.push(TimeBallotCard.preload())
  }
  return Promise.allSettled(wanted).then(() => undefined)
}
