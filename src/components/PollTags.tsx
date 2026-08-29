import { Badge, Group } from '@mantine/core'
import { badgeColor, countBadge } from '../lib/badgeColors'
import type { PollMode } from '../lib/types'

/**
 * A poll's high-level details, in the same shape on every screen that shows
 * a poll: a row of badges saying what kind of poll it is, and one badge
 * beside the title saying where it has got to.
 *
 * The row is the same four badges everywhere, in the same order: **invite
 * only/open link**, respondents shown/hidden, ballots published/private, then
 * how many have answered. The three settings run in the order `CreatePoll`
 * asks them, so the form that sets a poll's terms and the row that reports
 * them tell one story in one order. The count comes last because it is the
 * only one that is not a setting: it is the poll happening rather than its
 * terms.
 *
 * **Both states of every setting are always shown.** A tag that appeared for
 * only one of its states made its absence carry the other, and "no tag" is not
 * something anyone reads.
 *
 * The wording is deliberately not symmetrical: respondents are shown or
 * *hidden* — hiding them lists nobody, which is not the same as listing them
 * anonymously — while ballots are published or private. An anonymous ballot is
 * the two together: respondents hidden, ballots published.
 *
 * These tags are the only place a voter is told what happens to their ballot,
 * so every page carrying a ballot puts them above it, and every one of these
 * strings is decided here.
 *
 * **Where the poll has got to is not in this row.** It is a state rather than
 * a setting, the one thing on a card that moves on its own, and the only part
 * worth reading before deciding whether to open the poll — so it sits beside
 * the title as `PollStateBadge`, where a row of settings cannot bury it.
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
  /**
   * How many people have said they are done adding options — the badge's whole
   * content while the poll is collecting, because it is the number that is
   * moving then. Undefined against a database whose `poll_status` and
   * `list_polls` predate the column, which is the only reason `optionCount`
   * below still exists.
   */
  confirmedCount?: number
  /** How many options the poll holds. Only the fallback for the line above. */
  optionCount: number
  /**
   * How many questions the poll asks. Above one it takes the badge over
   * entirely; see turnoutLabel.
   *
   * Every screen that draws a poll passes it, so one poll wears one badge
   * wherever it is read. A page that does not yet know leaves `turnout` off
   * altogether rather than passing this undefined, since a turnout drawn now
   * is a turnout rewritten in a moment.
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
  confirmedCount,
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
    // Turnout is zero until the list is settled, so this stage counts what is
    // actually moving — and that is people, not options: seven options is
    // seven people with an idea each or one person with seven, and neither is
    // distinguishable from a poll nobody opened. Counting who is *done* has
    // the same shape and denominator as the turnout it gives way to, so "2/5
    // confirmed" today and "5/5 votes" next week count the same list of
    // people.
    //
    // The option count is the fallback and nothing else, for a browser talking
    // to a database that predates the confirmations.
    if (confirmedCount === undefined) {
      return `${optionCount} ${optionCount === 1 ? 'option' : 'options'}`
    }
    // No invite list, so no denominator to count towards — the same reason
    // an open poll's turnout below is a bare number.
    if (mode === 'open') return `${confirmedCount} confirmed`
    return `${confirmedCount}/${invitedCount} confirmed`
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
 * and *Collecting options*.
 *
 * Three outcomes are told apart rather than collapsed, because a reader
 * scanning a list of finished polls needs *what happened*, and "ready to look
 * at" is not that:
 *
 *  - a name: the option STAR elected;
 *  - *Tie*: the election ran and settled nothing, which STAR can genuinely
 *    produce and the app reports rather than inventing a result. It carries
 *    the colour of a tie-break that decided nothing;
 *  - *Results ready*: finished, and no single option is this badge's to name.
 *    A real state, not a fallback: a poll of several questions has a winner
 *    per question, so the badge names none and the question the reader opens
 *    names its own. A database older than the winner columns and a read that
 *    failed arrive here too. It must never read as *Tie*, which would be a
 *    wrong answer rather than a missing one.
 *
 * **Nothing here waits on anything.** `list_polls`, `poll_status` and
 * `open_poll_view` all carry the winner, so every state below is decided by
 * the read that drew the page — no in-flight case, and no flicker through
 * *Results ready* on the way to a name.
 */
export function PollStateBadge({
  soliciting,
  resultsAvailable,
  closed,
  winner,
  inGroup = false,
}: {
  soliciting: boolean
  resultsAvailable: boolean
  closed: boolean
  /**
   * The option that won, `null` for a poll that elected nobody, and
   * `undefined` for one whose result this page has not been told — a database
   * older than the columns that carry it, or a read that failed.
   */
  winner?: string | null
  /**
   * Whether this poll asks more than one question, in which case there is no
   * winner for this badge to name and it says so before it looks.
   *
   * Decided here rather than by each caller passing `winner: undefined`,
   * because "a poll of several questions names none of them" is one rule and
   * three screens draw this badge. Left to the callers, the poll list could
   * not keep it: a group's list row *is* its first question, so walking back
   * from that question handed the group's card the name it had just been told
   * to withhold.
   */
  inGroup?: boolean
}) {
  if (soliciting) {
    return (
      <Badge color={badgeColor.collectingOptions} variant="light" style={{ flexShrink: 0 }}>
        Collecting options
      </Badge>
    )
  }

  if (resultsAvailable) {
    // A poll of several questions, whose answer is one per question rather
    // than one at all. Ahead of everything below, including the wait: there
    // is nothing in flight for it and nothing that could arrive, so this is
    // its final state rather than a placeholder for one.
    if (inGroup) {
      return (
        <Badge color={badgeColor.done} variant="light" style={{ flexShrink: 0 }}>
          Results ready
        </Badge>
      )
    }
    if (winner === null) {
      return (
        <Badge color={badgeColor.unsettled} variant="light" style={{ flexShrink: 0 }}>
          Tie
        </Badge>
      )
    }
    // Finished, and nothing is going to tell this page what it decided: a
    // read that failed, or a database older than the columns carrying the
    // answer. A poll with several answers rather than one was caught above.
    if (winner === undefined) {
      return (
        <Badge color={badgeColor.done} variant="light" style={{ flexShrink: 0 }}>
          Results ready
        </Badge>
      )
    }
    // The only badge whose text belongs to the poll rather than to the app,
    // and so the only one with a ceiling: an elected option can be a sentence,
    // and past 40% of the heading's row the name ellipsises with the whole of
    // it on the `title` attribute. Every other badge is a fixed phrase the app
    // wrote and knows the length of, and keeps its width instead.
    //
    // 40% is a *max-width* rather than a basis, which is what makes the badge
    // exactly as wide as its name up to that point and the title's 60% a floor
    // rather than a serving. See PollHeading.
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
