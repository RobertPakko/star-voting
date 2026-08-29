import { lazy } from 'react'

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
 * `PollDetail` and `OpenPollPanel` — and two `lazy()` calls over one module
 * would be two component identities for one component, remounting the card
 * on any render that swapped which page held it.
 *
 * The types stay where their components are: `import type` is erased, so a
 * caller naming `ResultsSource` does not pull the chunk in with it.
 */

export const Results = lazy(() => import('./Results').then((m) => ({ default: m.Results })))

export const Ballots = lazy(() => import('./Ballots').then((m) => ({ default: m.Ballots })))
