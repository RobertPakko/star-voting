import { Badge, Group } from '@mantine/core'
import { badgeColor, countBadge } from '../lib/badgeColors'
import type { PollMode } from '../lib/types'

/**
 * A poll's high-level details, in the same shape on every screen that shows
 * a poll: a row of badges saying what kind of poll it is, and one badge
 * beside the title saying where it has got to.
 *
 * The row is the same four badges everywhere, in the same order and the same
 * words: **invite only/open link**, then respondents shown/hidden, then
 * ballots published/private, then how many have answered. The three settings
 * are in the order they are chosen in `CreatePoll`, who can vote, then
 * whether their names are shown, then whether their ballots are, so the
 * form that sets a poll's terms and the row that reports them tell one story
 * in one order, and nobody has to re-sort the row to check what they picked.
 * The count comes last of the four because it is the only one that is not a
 * setting at all: it is the poll happening rather than the poll's terms.
 *
 * Always-present matters more than it sounds: when a tag only appeared for
 * one of its two states, its absence had to be read as the other state, and
 * "no tag" is not something anyone reads. Showing both states of all three
 * settings means the terms of a poll can be taken in at a glance and
 * compared between polls.
 *
 * The wording is deliberately not symmetrical. Respondents are shown or
 * hidden, hiding them lists nobody at all, which is not the same as
 * listing them anonymously, while ballots are published or private. An
 * anonymous ballot is the two tags together: respondents hidden, ballots
 * published.
 *
 * These tags are also the only place a voter is told what happens to their
 * ballot, so every page carrying a ballot puts them above it. Changing any
 * of these strings means changing them here, which is the point of this file
 * existing.
 *
 * **Where the poll has got to is not in this row.** It is a state rather
 * than a setting, it is the one thing on a card that moves on its own, and
 * it is the only part worth reading before deciding whether to open the
 * poll at all; so it sits beside the title as `PollStateBadge`, on its own,
 * where a row of settings cannot bury it.
 */
export function PollTags({
  mode,
  showVoters,
  showBallots,
  turnout,
}: {
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
  /**
   * The numbers behind the count badge. Left off entirely; rather than
   * passed as zero; where the poll withholds participation from this
   * reader, since a badge saying nobody has voted is not the same as no
   * badge at all.
   */
  turnout?: Turnout
}) {
  return (
    <Group gap="xs">
      <Badge color={mode === 'open' ? badgeColor.openLink : badgeColor.inviteOnly} variant="light">
        {mode === 'open' ? 'Open link' : 'Invite only'}
      </Badge>
      <Badge
        color={showVoters ? badgeColor.respondentsShown : badgeColor.respondentsHidden}
        variant="light"
      >
        {showVoters ? 'Voters shown' : 'Voters hidden'}
      </Badge>
      <Badge
        color={showBallots ? badgeColor.ballotsPublished : badgeColor.ballotsPrivate}
        variant="light"
      >
        {showBallots ? 'Ballots published' : 'Ballots private'}
      </Badge>
      {turnout && <Badge {...countBadge}>{turnoutLabel(turnout)}</Badge>}
    </Group>
  )
}

/** What the count badge counts, which is not the same at every stage. */
export interface Turnout {
  soliciting: boolean
  mode: PollMode
  votedCount: number
  invitedCount: number
  /** Only read while collecting, when it is the number that is moving. */
  optionCount: number
  /**
   * How many questions the poll asks. Above one it takes the badge over
   * entirely; see turnoutLabel for why a multi-question poll has no turnout
   * number to report.
   */
  questionCount?: number
}

/**
 * How many have answered so far; which is not the same question at every
 * stage, and the badge says whichever one the poll is actually asking.
 *
 * It stays on the card after the poll closes. It used to be replaced by
 * "Results ready" the moment they were, which threw away the turnout the
 * result was reached on at exactly the point it became a permanent fact
 * about the poll; and said nothing the state badge does not now say better.
 *
 * Not exported: every string this file decides is decided in this file, and
 * a helper the callers could reach would be a second place for the wording
 * to drift to.
 */
function turnoutLabel({
  soliciting,
  mode,
  votedCount,
  invitedCount,
  optionCount,
  questionCount,
}: Turnout): string {
  // A poll that asks several questions has no turnout, only turnouts: each
  // question takes its own ballots, and the numbers come apart the moment
  // one person answers three of five. Reporting the first question's count
  // as the poll's would be a number that reads like the whole and is not,
  // so the badge says the one thing about the shape of the poll that is
  // true of all of it — how much of it there is to answer.
  if (questionCount !== undefined && questionCount > 1) {
    return `${questionCount} questions`
  }
  if (soliciting) {
    // Turnout is zero and stays zero until the list is settled, so this
    // stage counts what is actually moving: the options coming in.
    return `${optionCount} ${optionCount === 1 ? 'option' : 'options'}`
  }
  if (mode === 'open') {
    // No invite list, so no denominator to count towards.
    return `${votedCount} ${votedCount === 1 ? 'vote' : 'votes'}`
  }
  return `${votedCount}/${invitedCount} votes`
}

/**
 * Where the poll has got to, in one badge beside its title: collecting its
 * options, in progress, or finished; and a finished poll names the option
 * that won, because that is the answer the whole poll was for and the reason
 * anybody opens it again months later.
 *
 * The name is not prefixed with "Winner:". The badge is green, it sits where
 * every other poll's state sits, and the polls around it read *In progress*
 * and *Collecting options*; a label saying which question is being answered
 * is only worth its room when the answer alone would be ambiguous.
 *
 * Three outcomes are told apart rather than collapsed, because a reader
 * scanning a list of finished polls needs *what happened*, and "ready to
 * look at" is not that:
 *
 *  - a name: the option STAR elected;
 *  - *Tied*: the election ran and settled nothing, which STAR
 *    can genuinely produce and the app reports rather than inventing a
 *    result. It carries the colour of a tie-break that decided nothing,
 *    which is the same claim one level up;
 *  - *Results ready*: the poll is finished and this page is never going to be
 *    told which of the two it is. That is a real state, not a fallback: a poll
 *    of several questions has a winner per question and no single one to name,
 *    a browser talking to a database older than `poll_winners()` never learns
 *    it at all, and a request can simply fail. It must never read as *Tied*,
 *    which would be a wrong answer rather than a missing one.
 *
 * **A badge that is still resolving renders nothing at all**, which is what
 * `awaitingWinner` is for. The name arrives in a request behind the page, so
 * a finished poll used to draw *Results ready* for the hundred milliseconds
 * before its answer landed and then rewrite itself into the winner's name —
 * every load of every finished poll flickering through a state that was
 * true for nobody. Waiting costs a badge that appears a moment late; not
 * waiting costs one that is read and then contradicted. Nothing else on this
 * badge waits: *Collecting options*, *In progress* and *Closed* are decided
 * by the same read that drew the page, and a poll with an answer already in
 * hand draws it immediately.
 */
export function PollStateBadge({
  soliciting,
  resultsAvailable,
  closed,
  winner,
  awaitingWinner = false,
}: {
  soliciting: boolean
  resultsAvailable: boolean
  closed: boolean
  /**
   * The option that won, `null` for a poll that elected nobody, and
   * `undefined` for one whose result this page has not been told.
   */
  winner?: string | null
  /**
   * Whether an answer is still coming. `undefined` covers both "not yet" and
   * "not ever", and only the caller knows which it is holding; see the note
   * above on why the first of those draws nothing.
   */
  awaitingWinner?: boolean
}) {
  if (soliciting) {
    return (
      <Badge color={badgeColor.collectingOptions} variant="light" style={{ flexShrink: 0 }}>
        Collecting options
      </Badge>
    )
  }

  if (resultsAvailable) {
    // Still resolving: no badge rather than one that will be rewritten.
    if (winner === undefined && awaitingWinner) return null

    if (winner === null) {
      return (
        <Badge color={badgeColor.unsettled} variant="light" style={{ flexShrink: 0 }}>
          Tie
        </Badge>
      )
    }
    // Finished, and nothing is going to tell this page what it decided: a
    // poll of several questions has a winner per question and no single one
    // to name, so its card says the results are ready and leaves naming them
    // to the question the reader opens; and a request that failed, or a
    // database older than poll_winners(), ends here too. A request that is
    // merely still in flight was caught above.
    if (winner === undefined) {
      return (
        <Badge color={badgeColor.done} variant="light" style={{ flexShrink: 0 }}>
          Results ready
        </Badge>
      )
    }
    // The only badge here whose text belongs to the poll rather than to the
    // app, and so the only one with a ceiling: an elected option can be a
    // sentence, and past 40% of the heading's row the name ellipsises with
    // the whole of it on the `title` attribute.
    //
    // Every other badge on this row is a fixed phrase of the app's own —
    // *Collecting options* is the longest — and keeps its width instead.
    // Capping those at the same share would ellipsise a label the app wrote
    // and knows the length of, to make room for a title, on the one screen
    // narrow enough for 40% to bite. So the share is the answer to "how much
    // of the title may a poll's own text take", which is the only place the
    // question is actually asked.
    //
    // 40% is a *max-width* against the row rather than a basis, which is what
    // makes the badge exactly as wide as its name up to that point and the
    // title's 60% a floor rather than a serving. See PollHeading.
    return (
      <Badge
        color={badgeColor.done}
        variant="light"
        maw="40%"
        style={{ flexShrink: 0, flexGrow: 0 }}
        title={winner}
      >
        {winner}
      </Badge>
    )
  }

  if (closed) {
    // Closed with nothing in it: there is no result to name, and never will
    // be unless the creator resets it.
    return (
      <Badge color={badgeColor.closed} variant="light" style={{ flexShrink: 0 }}>
        Closed
      </Badge>
    )
  }

  return (
    <Badge color={badgeColor.outstanding} variant="light" style={{ flexShrink: 0 }}>
      In progress
    </Badge>
  )
}
